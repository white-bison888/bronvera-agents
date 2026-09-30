#!/usr/bin/env bash
# Выгружает промпты LLM-узлов живого воркфлоу Dify в agents/prompts/*.md.
#
# Зачем: промпты правятся мышью в Dify, а на диске должна лежать их копия —
# чтобы читать и сравнивать без захода на сервер. Файлы в agents/prompts/
# кодом не используются, это справка.
#
# Запуск из корня проекта:
#   scripts/dify/export-prompts.sh
#   scripts/dify/export-prompts.sh <workflow-id>     # конкретная версия
set -euo pipefail

SERVER="${BRONVERA_SERVER:-root@2.28.54.56}"
DB_CONTAINER="${DIFY_DB_CONTAINER:-docker-db_postgres-1}"
OUT_DIR="agents/prompts"

psql_q() {
  ssh -o BatchMode=yes -o ConnectTimeout=15 "$SERVER" \
    "docker exec -i $DB_CONTAINER psql -U postgres -d dify -t -A"
}

workflow_id="${1:-}"
if [ -z "$workflow_id" ]; then
  workflow_id=$(psql_q <<'SQL' | tr -d '[:space:]'
select workflow_id from apps where workflow_id is not null limit 1;
SQL
)
fi

if [ -z "$workflow_id" ]; then
  echo "Не нашёл опубликованный воркфлоу. Передай id первым аргументом." >&2
  exit 1
fi

echo "Воркфлоу: $workflow_id"
mkdir -p "$OUT_DIR"

dump=$(mktemp)
trap 'rm -f "$dump"' EXIT

psql_q >"$dump" <<SQL
select
  '===== ' || (n->'data'->>'title') || ' =====' || chr(10) ||
  coalesce(string_agg(p->>'text', chr(10)), '(нет prompt_template)')
from workflows w,
     jsonb_array_elements(w.graph::jsonb->'nodes') n,
     jsonb_array_elements(coalesce(n->'data'->'prompt_template','[]'::jsonb)) p
where w.id = '$workflow_id'
  and n->'data'->>'type' = 'llm'
group by n->'data'->>'title';
SQL

WORKFLOW_ID="$workflow_id" OUT_DIR="$OUT_DIR" python3 - "$dump" <<'PY'
import os, re, sys, datetime

src = open(sys.argv[1], encoding="utf-8").read()
parts = re.split(r'^===== (.+?) =====$', src, flags=re.M)

names = {
    "ORCHESTRATOR": "orchestrator.md",
    "Selector": "selector.md",
    "ASSESSOR": "assessor.md",
    "MARKET ANALYST": "market-analyst.md",
    "QUERY REFINER": "query-refiner.md",
}

out_dir = os.environ["OUT_DIR"]
workflow = os.environ["WORKFLOW_ID"]
today = datetime.date.today().isoformat()

if len(parts) < 3:
    sys.exit("Выгрузка пустая — проверь id воркфлоу и доступ к базе.")

for i in range(1, len(parts), 2):
    title, body = parts[i].strip(), parts[i + 1].strip("\n")
    filename = names.get(title)
    if not filename:
        filename = re.sub(r'[^a-z0-9]+', '-', title.lower()).strip('-') + ".md"
        print(f"новый узел {title} -> {filename}")
    header = (
        "<!-- ВЫГРУЗКА ИЗ DIFY. Не источник истины — копия для чтения без захода на сервер.\n"
        f"     Узел: {title}\n"
        f"     Воркфлоу: {workflow}\n"
        f"     Снято: {today}\n"
        "     Правится промпт в Dify, потом обновляется этот файл (scripts/dify/export-prompts.sh). -->\n\n"
    )
    with open(os.path.join(out_dir, filename), "w", encoding="utf-8") as fh:
        fh.write(header + body + "\n")
    print(f"{filename:<22} {len(body.splitlines())} строк")
PY

echo "Готово. Файлы в $OUT_DIR/"
