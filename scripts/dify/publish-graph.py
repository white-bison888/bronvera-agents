"""
Положить граф в черновик и опубликовать его — то же, что кнопка
«Опубликовать» в Dify, но из командной строки.

Запуск внутри контейнера api:
  docker exec -w /app/api -e PYTHONPATH=/app/api docker-api-1 \
    /app/api/.venv/bin/python /tmp/publish-graph.py /tmp/graph.json "имя версии"

Две шага в РАЗНЫХ сессиях: sync_draft_workflow делает commit сам, и
публикация в той же транзакции падает с «Can't operate on closed transaction».

Старый черновик сохраняется рядом с графом: <граф>.before.json.
"""

import json
import sys

from app_factory import create_app

APP_ID = "bf123c55-2d67-45e7-a30c-032d9553a379"

graph_file = sys.argv[1] if len(sys.argv) > 1 else "/tmp/graph.json"
mark = sys.argv[2] if len(sys.argv) > 2 else ""
comment = sys.argv[3] if len(sys.argv) > 3 else ""

graph = json.load(open(graph_file))

created = create_app()
app = next((item for item in (created if isinstance(created, tuple) else [created]) if hasattr(item, "app_context")), None)

if app is None:
    raise SystemExit("не нашёл flask-приложение в create_app()")

with app.app_context():
    from sqlalchemy import select
    from sqlalchemy.orm import sessionmaker

    from extensions.ext_database import db
    from models.account import Account
    from models.model import App
    from models.workflow import Workflow
    from services.workflow_service import WorkflowService

    service = WorkflowService()
    Session = sessionmaker(db.engine)

    # Шаг 1: черновик
    session = Session()

    try:
        app_model = session.scalar(select(App).where(App.id == APP_ID))
        draft = session.scalar(
            select(Workflow).where(Workflow.app_id == APP_ID, Workflow.version == Workflow.VERSION_DRAFT)
        )

        if not app_model or not draft:
            raise SystemExit("приложение или черновик не найдены")

        with open(graph_file + ".before.json", "w") as backup:
            backup.write(draft.graph)

        account = session.scalar(select(Account).where(Account.id == draft.created_by)) \
            or session.scalar(select(Account).where(Account.id == app_model.created_by))

        было = len(json.loads(draft.graph).get("nodes", []))

        service.sync_draft_workflow(
            app_model=app_model,
            graph=graph,
            features=json.loads(draft.features or "{}"),
            unique_hash=draft.unique_hash,
            account=account,
            environment_variables=draft.environment_variables,
            conversation_variables=draft.conversation_variables,
            session=session,
        )

        print("черновик обновлён: узлов было", было, "стало", len(graph.get("nodes", [])))
    finally:
        session.close()

    # Шаг 2: версия
    session = Session()

    try:
        app_model = session.scalar(select(App).where(App.id == APP_ID))
        account = session.scalar(select(Account).where(Account.id == app_model.created_by))
        draft = session.scalar(
            select(Workflow).where(Workflow.app_id == APP_ID, Workflow.version == Workflow.VERSION_DRAFT)
        )
        account = session.scalar(select(Account).where(Account.id == draft.created_by)) or account

        published = service.publish_workflow(
            session=session,
            app_model=app_model,
            account=account,
            marked_name=mark,
            marked_comment=comment,
        )

        session.flush()

        published_id, published_version = published.id, published.version

        app_in_session = session.get(App, APP_ID)
        app_in_session.workflow_id = published_id
        app_in_session.updated_by = account.id

        session.commit()
        print("опубликовано →", published_id, published_version)
    finally:
        session.close()
