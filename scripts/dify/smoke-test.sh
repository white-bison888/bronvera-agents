#!/usr/bin/env bash
# Прогоняет один настоящий поиск через опубликованный воркфлоу Dify и печатает
# статус, время, токены и стоимость по узлам. Нужен после каждой публикации
# графа: без живого прогона неизвестно, работает ли схема.
#
# Ключ приложения берётся из базы Dify и НЕ печатается.
# Запускать НА СЕРВЕРЕ (нужен доступ к localhost и контейнерам):
#   scp scripts/dify/smoke-test.sh root@<сервер>:/tmp/ && ssh root@<сервер> 'bash /tmp/smoke-test.sh'
#   ssh root@<сервер> 'bash /tmp/smoke-test.sh "Найди Tesla Model 3 2022 года"'
set -euo pipefail

APP_ID="${DIFY_APP_ID:-bf123c55-2d67-45e7-a30c-032d9553a379}"
DB="${DIFY_DB_CONTAINER:-docker-db_postgres-1}"
REQUEST="${1:-Найди Tesla Model Y 2023-2024 годов}"
OUT="${2:-/tmp/smoke-test-run.json}"

psql_q() { docker exec -i "$DB" psql -U postgres -d dify -t -A; }

KEY=$(psql_q <<SQL | tr -d '[:space:]'
select token from api_tokens where app_id = '$APP_ID' order by created_at desc limit 1;
SQL
)

if [ -z "$KEY" ]; then
  echo "В api_tokens нет ключа для приложения $APP_ID — создай ключ в Dify." >&2
  exit 1
fi
echo "Ключ приложения найден (${#KEY} символов, не печатаю)."
echo "Запрос: $REQUEST"
echo "Пошёл прогон, это 3–6 минут…"
echo

started=$(date +%s)
curl -sS --max-time 900 -X POST http://localhost/v1/workflows/run \
  -H "Authorization: Bearer $KEY" \
  -H "Content-Type: application/json" \
  --data-binary @- >"$OUT" <<JSON
{"inputs":{"user_request":$(python3 -c 'import json,sys; print(json.dumps(sys.argv[1]))' "$REQUEST")},
 "response_mode":"blocking","user":"smoke-test"}
JSON
echo "прошло секунд по часам: $(( $(date +%s) - started ))"
echo

OUT="$OUT" python3 <<'PY'
import json, os

data = json.load(open(os.environ["OUT"]))
run = data.get("data") or {}

print("run_id :", data.get("workflow_run_id"))
print("статус :", run.get("status"))
print("секунд :", round(run.get("elapsed_time") or 0, 1))
print("токенов:", run.get("total_tokens"))

if run.get("error"):
    print("\nОШИБКА:", str(run["error"])[:500])

outputs = run.get("outputs") or {}
print("выходы :", ", ".join(outputs.keys()) or "(нет)")

for name, value in outputs.items():
    text = value if isinstance(value, str) else json.dumps(value, ensure_ascii=False)
    print(f"\n--- {name} ({len(text)} символов) ---")
    print(text[:600])
PY

echo
echo "--- стоимость по узлам этого прогона ---"
RUN_ID=$(python3 -c 'import json,os; print((json.load(open(os.environ["OUT"])) or {}).get("workflow_run_id") or "")' 2>/dev/null || true)
if [ -n "$RUN_ID" ]; then
  psql_q <<SQL
select rpad(title, 16) || ' ' ||
       lpad(coalesce(execution_metadata::jsonb->>'total_tokens','-'), 7) || ' т.  $' ||
       coalesce(execution_metadata::jsonb->>'total_price','-')
from workflow_node_executions
where workflow_run_id = '$RUN_ID' and node_type = 'llm'
order by created_at;
SQL
  psql_q <<SQL
select 'ИТОГО ИИ: \$' || round(sum((execution_metadata::jsonb->>'total_price')::numeric), 4)
from workflow_node_executions
where workflow_run_id = '$RUN_ID' and node_type = 'llm';
SQL
fi
