#!/usr/bin/env bash
# Пересчитывает уроки из истории и, если они изменились, вшивает их в промпты
# и публикует граф. При неудачной проверке возвращает прежнюю версию сам.
#
# Пятый принцип методологии работает только пока уроки свежие. Один раз их уже
# завели и забыли — файлы agents/lessons/*.md месяцами лежали пустыми. Поэтому
# здесь всё одной командой, без ручных шагов.
#
# Запуск на сервере (обычно из systemd-таймера bronvera-lessons.timer):
#   bash /opt/bronvera-agents/scripts/dify/refresh-lessons.sh
#
# Выход: 0 — либо ничего не менялось, либо опубликовано и проверено.
#        1 — что-то сломалось; если дело было в публикации, прежняя версия
#            уже возвращена, менять руками ничего не нужно.
set -uo pipefail

ROOT="${BRONVERA_ROOT:-/opt/bronvera-agents}"
APP_ID="${DIFY_APP_ID:-bf123c55-2d67-45e7-a30c-032d9553a379}"
DB="${DIFY_DB_CONTAINER:-docker-db_postgres-1}"
API="${DIFY_API_CONTAINER:-docker-api-1}"
LOG="${BRONVERA_LESSONS_LOG:-/var/log/bronvera-lessons.log}"
HEALTH_QUERY="${BRONVERA_HEALTH_QUERY:-Найди Tesla Model S 2020 года}"

WORK=$(mktemp -d)
trap 'rm -rf "$WORK"' EXIT

say() { echo "$(date '+%Y-%m-%d %H:%M:%S') $*" | tee -a "$LOG"; }

cd "$ROOT" || { say "нет каталога $ROOT"; exit 1; }

# 1. Пересчёт уроков
if ! node src/lessons/build-lessons.js >"$WORK/build.log" 2>&1; then
  say "ОШИБКА: пересчёт уроков упал"; sed 's/^/    /' "$WORK/build.log" | tee -a "$LOG"; exit 1
fi
say "уроки пересчитаны: $(tr '\n' ' ' <"$WORK/build.log")"

# 2. Что уже вшито в живой граф
docker exec -i "$DB" psql -U postgres -d dify -t -A \
  -c "select graph from workflows where app_id='$APP_ID' and version='draft';" >"$WORK/graph-live.json"

if [ ! -s "$WORK/graph-live.json" ]; then
  say "ОШИБКА: не удалось выгрузить граф из базы Dify"; exit 1
fi

# 3. Собираем граф с новыми уроками. Код возврата 2 от inject-lessons.py
#    значит «текст уроков тот же, что уже вшит» — публиковать нечего.
python3 scripts/dify/inject-lessons.py "$WORK/graph-live.json" "$WORK/graph-new.json" agents/lessons \
  >"$WORK/inject.log" 2>&1
INJECT=$?

case "$INJECT" in
  0) : ;;
  2) say "уроки не изменились — публикация не нужна"; exit 0 ;;
  *) say "ОШИБКА: вшивание уроков упало"; sed 's/^/    /' "$WORK/inject.log" | tee -a "$LOG"; exit 1 ;;
esac

say "уроки изменились, публикую"

# 4. Публикация
cp "$WORK/graph-live.json" "$WORK/graph-rollback.json"
docker cp "$WORK/graph-new.json" "$API:/tmp/graph-lessons-auto.json" >/dev/null
docker cp "$WORK/graph-rollback.json" "$API:/tmp/graph-lessons-rollback.json" >/dev/null
docker cp scripts/dify/publish-graph.py "$API:/tmp/publish-graph.py" >/dev/null

publish() {
  docker exec -w /app/api -e PYTHONPATH=/app/api "$API" \
    /app/api/.venv/bin/python /tmp/publish-graph.py "$1" "$2" "$3" 2>&1
}

if ! publish /tmp/graph-lessons-auto.json "уроки $(date +%F)" "пересчёт по расписанию" >"$WORK/publish.log"; then
  say "ОШИБКА: публикация упала, граф остался прежним"
  sed 's/^/    /' "$WORK/publish.log" | tee -a "$LOG"
  exit 1
fi
say "опубликовано: $(grep -o 'опубликовано →.*' "$WORK/publish.log" || echo '?')"

# 5. Проверка живым прогоном; при провале — откат
if ! bash scripts/dify/smoke-test.sh "$HEALTH_QUERY" "$WORK/health.json" >"$WORK/smoke.log" 2>&1; then
  say "проверка не прошла — откатываю"
  publish /tmp/graph-lessons-rollback.json "откат уроков" "проверка после публикации не прошла" | sed 's/^/    /' | tee -a "$LOG"
  sed 's/^/    /' "$WORK/smoke.log" | tail -20 | tee -a "$LOG"
  exit 1
fi

STATUS=$(python3 -c "
import json,sys
try: print((json.load(open('$WORK/health.json')).get('data') or {}).get('status'))
except Exception: print('нет ответа')
")

if [ "$STATUS" != "succeeded" ]; then
  say "прогон вернул статус «$STATUS» — откатываю"
  publish /tmp/graph-lessons-rollback.json "откат уроков" "прогон после публикации не удался" | sed 's/^/    /' | tee -a "$LOG"
  exit 1
fi

say "готово: уроки обновлены, прогон проходит"
