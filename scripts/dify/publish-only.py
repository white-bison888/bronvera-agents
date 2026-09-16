"""
Опубликовать текущий черновик воркфлоу BRONVERA и перевести приложение
на новую версию — то же, что кнопка «Опубликовать» в Dify.

Черновик уже содержит нужный граф (его положил publish-v16.py).
Запуск: python /tmp/publish-only.py
"""

import json

from app_factory import create_app

APP_ID = "bf123c55-2d67-45e7-a30c-032d9553a379"
MARK = "v16 уточнитель запроса"
COMMENT = "Словарь реестра + QUERY REFINER: комплектации и бюджет, экран уточнения вместо пустого поиска"

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

    session = sessionmaker(db.engine)()

    try:
        app_model = session.scalar(select(App).where(App.id == APP_ID))
        draft = session.scalar(
            select(Workflow).where(Workflow.app_id == APP_ID, Workflow.version == Workflow.VERSION_DRAFT)
        )

        if not app_model or not draft:
            raise SystemExit("приложение или черновик не найдены")

        titles = [node.get("data", {}).get("title") for node in json.loads(draft.graph).get("nodes", [])]
        print("черновик:", len(titles), "узлов;", "СЛОВАРЬ" in titles, "REFINER CHECK" in titles, "Уточнение" in titles)
        print("приложение сейчас →", app_model.workflow_id)

        account = session.scalar(select(Account).where(Account.id == draft.created_by)) \
            or session.scalar(select(Account).where(Account.id == app_model.created_by))

        published = WorkflowService().publish_workflow(
            session=session,
            app_model=app_model,
            account=account,
            marked_name=MARK,
            marked_comment=COMMENT,
        )

        session.flush()

        published_id = published.id
        published_version = published.version

        app_in_session = session.get(App, APP_ID)
        app_in_session.workflow_id = published_id
        app_in_session.updated_by = account.id

        session.commit()
        print("опубликовано →", published_id, published_version)
    finally:
        session.close()
