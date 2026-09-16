# Граф воркфлоу Dify: сборка и публикация

Экраны Dify правит человек мышью, но крупные правки графа (новые узлы,
переписанные промпты) удобнее собирать скриптом и публиковать одним шагом.
Так сделана версия v16 — уточнитель запроса перед дорогими шагами.

## Как это работает

1. `build-v16.py` берёт выгрузку текущего графа (`SELECT graph FROM workflows
   WHERE id = '<версия>'`, положить рядом как `workflow-graph.json`) и собирает
   новый: добавляет узлы СЛОВАРЬ → QUERY REFINER → REFINER CHECK →
   «ЗАПРОС ПОНЯТЕН?» → поиск либо End «Уточнение», дописывает выходы
   `search_meta` и `notes`. Результат — `graph-v16.json`.
2. `publish-v16.py` кладёт граф в черновик приложения (`sync_draft_workflow`)
   и публикует версию; `publish-only.py` публикует уже готовый черновик —
   он нужен, если публикация упала после записи черновика.

## Запуск на сервере

```
scp graph-v16.json publish-only.py root@<сервер>:/tmp/
ssh root@<сервер> 'docker cp /tmp/publish-only.py docker-api-1:/tmp/ && \
  docker exec -w /app/api -e PYTHONPATH=/app/api docker-api-1 \
  /app/api/.venv/bin/python /tmp/publish-only.py'
```

Три грабли: интерпретатор только из `/app/api/.venv` (в системном нет
зависимостей), нужен `PYTHONPATH=/app/api`, а `create_app()` отдаёт пару
`(WSGIApp, DifyApp)` — приложение Flask второе.

`sync_draft_workflow` сам делает commit, поэтому его нельзя звать внутри
`sessionmaker(...).begin()` — транзакция закроется, и публикация упадёт.

## Откат

Старый черновик остаётся в контейнере: `/tmp/graph-draft-before-v16.json`.
Вернуть приложение на прежнюю версию — поставить `apps.workflow_id` обратно
(в v16 это было `e67f61b2-5cc2-418f-8dfe-4a18a25b8cee`).
