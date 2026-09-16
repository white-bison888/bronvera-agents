"""
Публикация новой версии воркфлоу BRONVERA изнутри docker-api-1.

Делает то же, что кнопка «Опубликовать» в Dify: кладёт граф в черновик,
создаёт версию и переводит приложение на неё. Старый черновик сохраняется
в /tmp/graph-draft-before-v16.json — на случай откат.

Запуск: python /tmp/publish-v16.py /tmp/graph-v16.json
"""

import json
import sys

from app_factory import create_app

APP_ID = "bf123c55-2d67-45e7-a30c-032d9553a379"
MARK = "v16 уточнитель запроса"
COMMENT = "Словарь реестра + QUERY REFINER: комплектации и бюджет, экран уточнения вместо пустого поиска"

graph = json.load(open(sys.argv[1] if len(sys.argv) > 1 else "/tmp/graph-v16.json"))

created = create_app()
# В этой версии Dify create_app() отдаёт (WSGIApp, DifyApp): нужен второй.
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

    with sessionmaker(db.engine).begin() as session:
        app_model = session.scalar(select(App).where(App.id == APP_ID))

        if not app_model:
            raise SystemExit("приложение не найдено")

        draft = session.scalar(
            select(Workflow).where(
                Workflow.app_id == APP_ID,
                Workflow.version == Workflow.VERSION_DRAFT,
            )
        )

        if not draft:
            raise SystemExit("черновик не найден")

        with open("/tmp/graph-draft-before-v16.json", "w") as backup:
            backup.write(draft.graph)

        account = session.scalar(select(Account).where(Account.id == draft.created_by)) \
            or session.scalar(select(Account).where(Account.id == app_model.created_by))

        if not account:
            raise SystemExit("автор воркфлоу не найден")

        print("было: приложение →", app_model.workflow_id, "черновик", draft.id, "узлов", len(json.loads(draft.graph).get("nodes", [])))

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

        published = service.publish_workflow(
            session=session,
            app_model=app_model,
            account=account,
            marked_name=MARK,
            marked_comment=COMMENT,
        )

        session.flush()

        app_in_session = session.get(App, app_model.id)
        app_in_session.workflow_id = published.id
        app_in_session.updated_by = account.id

        print("стало: приложение →", published.id, "версия", published.version, "узлов", len(graph.get("nodes", [])))
