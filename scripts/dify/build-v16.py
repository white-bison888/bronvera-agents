"""
Новая версия воркфлоу BRONVERA: уточнитель запроса перед дорогими шагами.

Начало → СЛОВАРЬ (реестр: марки, модели, комплектации) → QUERY REFINER →
REFINER CHECK → ЕСЛИ/ИНАЧЕ → поиск или экран уточнения.

Скрипт только собирает JSON графа; публикует его publish-v16.py.
"""

import json
import os

SP = os.path.dirname(os.path.abspath(__file__))
graph = json.load(open(os.path.join(SP, "..", "workflow-graph.json")))

START = "1788452158231"
REFINER = "1788516999265"      # был SEARCH PARSER
SEARCH = "1788453053920"       # HTTP-запрос /api/cars/search
HTTP_CHECK = "1788535439543"
END_NONE = "1788536786870"     # «Вывод» — ничего не найдено
END_FOUND = "1788543144218"    # «Выводы» — лоты с расчётом

VOCAB = "1789600000010"
CHECK = "1789600000020"
BRANCH = "1789600000030"
END_CLARIFY = "1789600000040"

node = {n["id"]: n for n in graph["nodes"]}

# ----------------------------------------------------------------------
# СЛОВАРЬ РЕЕСТРА
# ----------------------------------------------------------------------

vocab_node = {
    "id": VOCAB,
    "type": "custom",
    "sourcePosition": "right",
    "targetPosition": "left",
    "zIndex": 0,
    "width": 242,
    "height": 137,
    "selected": False,
    "position": {"x": 115.0, "y": -105.0},
    "positionAbsolute": {"x": 115.0, "y": -105.0},
    "data": {
        "type": "http-request",
        "title": "СЛОВАРЬ",
        "method": "get",
        "url": "http://host.docker.internal:3001/api/search/vocabulary",
        "headers": "X-Workflow-Run-Id:{{#sys.workflow_run_id#}}",
        "params": "",
        "body": {"type": "none", "data": []},
        "authorization": {"config": None, "type": "no-auth"},
        "variables": [],
        "retry_config": {"max_retries": 3, "retry_interval": 100, "retry_enabled": True},
        "timeout": {"max_connect_timeout": 0, "max_write_timeout": 0, "max_read_timeout": 0},
        "ssl_verify": True,
        "selected": False,
    },
}

# ----------------------------------------------------------------------
# QUERY REFINER
# ----------------------------------------------------------------------

REFINER_SYSTEM = """Ты — QUERY REFINER системы BRONVERA.

BRONVERA отслеживает прогноз по лотам страховых аукционов США: находит
лоты под запрос, прогнозирует цену торгов, цену такой машины в Беларуси и
выгодность. Ты первый шаг: превращаешь запрос человека в параметры поиска
по реестру лотов — или останавливаешь поиск и просишь уточнить.

Дальше идут дорогие шаги (разбор фотографий, цены Беларуси, расчёт по
каждому лоту): один поиск стоит около доллара и идёт минутами. Поэтому
пустой или бессмысленный поиск лучше не начинать вовсе.

СЛОВАРЬ РЕЕСТРА

Тебе дан словарь: какими словами названы марки, модели и комплектации
лотов с открытыми торгами. Названия моделей и комплектаций бери из него.

Словарь — подсказка, а не полный каталог: покрытие реестра неполное, и
отсутствие модели в словаре не значит, что её нет на bid.cars. Если
марка и модель названы правильными словами, ищи, даже когда в словаре
их нет.

ГЛАВНОЕ ПРАВИЛО О КОМПЛЕКТАЦИЯХ

100D, P100D, Plaid, Long Range, Performance, Standard Range, 85D — это
КОМПЛЕКТАЦИИ (версии), а не модели. Модели Tesla: Model S, Model X,
Model 3, Model Y, Cybertruck.

Комплектации всегда идут в поле trims, никогда в models. Если человек
назвал только комплектацию, а модель не назвал, — модель придётся
спросить: у Model S и Model X бывают разные версии, и поиск по всем
моделям марки вернул бы не то, что человек просил.

ПАРАМЕТРЫ ПОИСКА

make — марка строкой: "Tesla", "BMW". Не названа — null.
models — список моделей словами словаря: ["Model Y"], ["Model S", "Model X"].
trims — список комплектаций: ["100D", "P100D"]. Сверяется с комплектацией
лота по началу слова, поэтому пиши так, как в словаре.
yearFrom, yearTo — год выпуска включительно.
mileageMin, mileageMax — пробег в МИЛЯХ (аукционы США считают в милях).
priceMin, priceMax — бюджет в долларах. Это ПРОГНОЗ ЦЕНЫ ТОРГОВ, а не
текущая ставка: "до $10 000" → priceMax: 10000.
startCodes — ["run_and_drive"] для "на ходу", ["starts"] для "заводится".
fuelTypes — "electric", "hybrid", "gasoline", "diesel", "other".
driveTypes — "awd", "fwd", "rwd", "other".
bodyStyles — "sedan", "suv", "crossover", "coupe", "convertible",
"hatchback", "wagon", "pickup", "van", "minivan", "other".
transmissions — "automatic", "manual", "other".
auctionTypes — площадки, если названы: ["Copart"], ["IAAI"].
maxResults — сколько лотов вернуть, по умолчанию 20.
maxPages — сколько страниц каталога просматривать, по умолчанию 1.

Толкование года:
— "2022 и новее", "от 2022", "2022+" → yearFrom: 2022, yearTo: null
— "до 2020", "не новее 2020" → yearFrom: null, yearTo: 2020
— "2021–2025" → yearFrom: 2021, yearTo: 2025
— "2023 года" → yearFrom: 2023, yearTo: 2023

Особый случай — слово "старше". В разговорной речи "2022 и старше" почти
всегда значит "2022 года и новее": человека интересуют свежие машины.
— "2022 и старше" → yearFrom: 2022
— "не старше 2022" → yearFrom: 2022
Ставь yearTo только когда верхняя граница названа однозначно.

Пробег:
— "до 100к", "не больше 100 000" → mileageMax: 100000
— "от 20 до 60 тысяч" → mileageMin: 20000, mileageMax: 60000
Сказано "километров" — переведи в мили делением на 1.609.

Не придумывай того, чего в запросе нет, и не сужай поиск сверх сказанного.
Не расширяй: названа Model Y — не добавляй Model 3. Исключение — топливо:
для Tesla всегда ["electric"], это свойство марки.

КОГДА ОСТАНАВЛИВАТЬ ПОИСК

status: "clarify" — если хотя бы одно верно:

1. no_make — не названы ни марка, ни модель: искать пришлось бы весь
   каталог, и это часы работы и деньги впустую.
2. trim_as_model — названа комплектация, а модель нет (наш случай
   "Tesla 100D, P100D, Plaid").
3. model_unknown — модель названа словом, которого нет ни в словаре, ни
   среди известных тебе моделей этой марки: скорее всего это комплектация,
   опечатка или другая марка.
4. contradictory — условия противоречат друг другу: "2015 года новее
   2020-го", "Model 3 с кузовом пикап".
5. not_a_car — запрос не про подбор автомобиля.
6. too_broad — запрос настолько широкий, что разбор будет случайным:
   названа только марка без модели, года, пробега и бюджета, а лотов
   этой марки в реестре больше сотни.

status: "ok" — во всех остальных случаях. Сомневаешься между "ok" и
"clarify" при названных марке и модели — ищи: пустая выдача дешевле
лишнего вопроса.

ЧТО НЕ ОСТАНАВЛИВАЕТ ПОИСК, НО ТРЕБУЕТ ПРЕДУПРЕЖДЕНИЯ

warnings — список того, о чём человека надо предупредить, не прерывая
поиска. Код и одна фраза:
— non_ev: запрос не про электромобиль. Расчёт ввоза в Беларуси настроен
  для электромобилей, для бензиновых и дизельных цифры предварительные.
— low_budget: бюджет заметно ниже прогнозов по таким лотам — скорее
  всего покажем самые дешёвые из подходящих.
Нечего сказать — пустой список.

ОСОБЫЙ РЕЖИМ: СПИСОК ДНЯ

Каждое утро BRONVERA сама просматривает открытые торги Tesla и составляет
два списка лучших лотов дня: до $15 000 и до $10 000 ожидаемой цены.
Просят этот список — "лучшие лоты дня", "отбор дня", "что сегодня
выгодного" — верни status "ok" и filters: {"mode": "screener",
"maxPriceUsd": 15000} (или 10000, если назван порог до десяти тысяч).
Запрос с маркой, моделью, годом или пробегом — обычный поиск, даже если
в нём есть слово «сегодня».

ФОРМАТ ОТВЕТА

Верни ТОЛЬКО валидный JSON без markdown и пояснений:

{
  "status": "ok" | "clarify",
  "understood": "как ты понял запрос, одной фразой по-русски",
  "filters": { ... параметры выше ... },
  "warnings": [{"code": "non_ev", "title": "…", "detail": "…"}],
  "summary": "для clarify: чего не хватает, одной короткой фразой",
  "reasons": [{"code": "trim_as_model", "title": "коротко", "detail": "подробнее"}],
  "suggestions": [{"query": "готовый запрос целиком", "why": "чем отличается"}]
}

Для "ok" reasons и suggestions — пустые списки, summary — пустая строка.
Для "clarify" filters всё равно заполни тем, что удалось разобрать: это
видно человеку как «как понят запрос».

ПРАВИЛА ДЛЯ SUGGESTIONS

Два-три готовых запроса, которые человек запустит одной кнопкой. Каждый —
законченная фраза на русском, как если бы он написал её сам, со всем, что
было в исходном запросе. Разные по смыслу, а не переформулировки одного:
разные модели, шире бюджет, без комплектации. В "why" — одна короткая
фраза, чем этот вариант отличается.

ПРИМЕРЫ

Запрос: "Tesla 100D, P100D, Plaid до $10000"

{
  "status": "clarify",
  "understood": "Tesla, комплектации 100D, P100D, Plaid, прогноз цены торгов до $10 000; модель не названа",
  "filters": {"make": "Tesla", "models": [], "trims": ["100D", "P100D", "Plaid"], "priceMax": 10000, "fuelTypes": ["electric"]},
  "warnings": [],
  "summary": "Названы комплектации, но не модель",
  "reasons": [
    {"code": "trim_as_model", "title": "100D, P100D и Plaid — комплектации, а не модели", "detail": "На bid.cars они бывают у Model S и Model X, и версия у лота часто определяется по VIN неточно"},
    {"code": "no_model", "title": "Без модели поиск пойдёт по всей марке", "detail": "В реестре больше сотни открытых лотов Tesla, и разбор достался бы случайным"}
  ],
  "suggestions": [
    {"query": "Tesla Model S 100D или P100D, прогноз цены торгов до $10 000", "why": "только Model S"},
    {"query": "Tesla Model X 100D или P100D до $15 000", "why": "Model X и бюджет выше"},
    {"query": "Tesla Model S и Model X 2017–2019 годов до $10 000", "why": "без комплектации, по годам"}
  ]
}

Запрос: "Найди Tesla Model Y 2023–2024 годов"

{
  "status": "ok",
  "understood": "Tesla Model Y 2023–2024 годов",
  "filters": {"make": "Tesla", "models": ["Model Y"], "yearFrom": 2023, "yearTo": 2024, "fuelTypes": ["electric"], "maxResults": 20, "maxPages": 1},
  "warnings": [],
  "summary": "",
  "reasons": [],
  "suggestions": []
}

Запрос: "Toyota Camry 2018 года на ходу до $6000"

{
  "status": "ok",
  "understood": "Toyota Camry 2018 года, на ходу, прогноз цены торгов до $6 000",
  "filters": {"make": "Toyota", "models": ["Camry"], "yearFrom": 2018, "yearTo": 2018, "priceMax": 6000, "startCodes": ["run_and_drive"], "maxResults": 20, "maxPages": 1},
  "warnings": [{"code": "non_ev", "title": "Это не электромобиль", "detail": "Расчёт ввоза в Беларусь настроен для электромобилей: для бензиновых машин пошлина и НДС другие, и выгодность будет предварительной"}],
  "summary": "",
  "reasons": [],
  "suggestions": []
}"""

REFINER_USER = """СЛОВАРЬ РЕЕСТРА:

{{#""" + VOCAB + """.body#}}

ЗАПРОС ПОЛЬЗОВАТЕЛЯ:

{{#""" + START + """.user_request#}}"""

node[REFINER]["data"]["title"] = "QUERY REFINER"
node[REFINER]["data"]["prompt_template"] = [
    {"role": "system", "text": REFINER_SYSTEM},
    {"role": "user", "text": REFINER_USER},
]

# ----------------------------------------------------------------------
# REFINER CHECK
# ----------------------------------------------------------------------

CHECK_CODE = '''import json
import re

# Только эти поля понимает поиск по реестру; всё остальное отбрасываем.
ALLOWED = [
    "make", "models", "yearFrom", "yearTo", "mileageMin", "mileageMax",
    "fuelTypes", "bodyStyles", "driveTypes", "transmissions", "startCodes",
    "auctionTypes", "trims", "priceMin", "priceMax", "maxResults", "maxPages",
]


def parse(text):
    if not text:
        return None

    cleaned = re.sub(r"<think>.*?</think>", "", str(text), flags=re.DOTALL)
    start = cleaned.find("{")
    end = cleaned.rfind("}")

    if start == -1 or end <= start:
        return None

    try:
        return json.loads(cleaned[start:end + 1])
    except Exception:
        return None


def items(value):
    return [item for item in value if isinstance(item, dict)] if isinstance(value, list) else []


def main(arg1: str) -> dict:
    data = parse(arg1) or {}
    filters = data.get("filters")

    if not isinstance(filters, dict):
        filters = {}

    # Предупреждения идут дальше вместе с результатом: поиск они не прерывают.
    notes = " · ".join([
        " — ".join([part for part in [str(item.get("title") or "").strip(), str(item.get("detail") or "").strip()] if part])
        for item in items(data.get("warnings"))
    ][:3])

    # Список дня идёт мимо фильтров: его собирает сам backend.
    if str(filters.get("mode") or "") == "screener":
        threshold = filters.get("maxPriceUsd")

        return {
            "status": "ok",
            "filters_json": json.dumps({
                "mode": "screener",
                "maxPriceUsd": threshold if isinstance(threshold, (int, float)) else 15000,
            }, ensure_ascii=False),
            "clarification": "",
            "message": "",
            "notes": notes,
        }

    clean = {}

    for key in ALLOWED:
        value = filters.get(key)

        if value is None or value == "" or value == []:
            continue

        clean[key] = value

    # Без марки и модели поиск просмотрел бы весь каталог — это часы и деньги впустую.
    enough = bool(clean.get("make")) or bool(clean.get("models"))
    status = str(data.get("status") or "").strip().lower()

    if status != "ok" or not enough:
        reasons = [
            {
                "code": str(item.get("code") or ""),
                "title": str(item.get("title") or "").strip(),
                "detail": str(item.get("detail") or "").strip(),
            }
            for item in items(data.get("reasons"))
            if str(item.get("title") or "").strip()
        ]

        if not enough and not any(item["code"] in ("no_make", "no_model", "trim_as_model") for item in reasons):
            reasons.append({
                "code": "no_make",
                "title": "Не названы марка и модель",
                "detail": "Без них поиск пришлось бы вести по всему каталогу аукционов.",
            })

        suggestions = [
            {"query": str(item.get("query") or "").strip(), "why": str(item.get("why") or "").strip()}
            for item in items(data.get("suggestions"))
            if str(item.get("query") or "").strip()
        ]

        summary = str(data.get("summary") or "").strip() or "Запрос нужно уточнить"

        clarification = {
            "summary": summary,
            "understood": str(data.get("understood") or "").strip(),
            "reasons": reasons,
            "suggestions": suggestions[:3],
        }

        return {
            "status": "clarify",
            "filters_json": "",
            "clarification": json.dumps(clarification, ensure_ascii=False),
            "message": summary,
            "notes": notes,
        }

    clean.setdefault("maxResults", 20)
    clean.setdefault("maxPages", 1)

    return {
        "status": "ok",
        "filters_json": json.dumps(clean, ensure_ascii=False),
        "clarification": "",
        "message": "",
        "notes": notes,
    }
'''

check_node = {
    "id": CHECK,
    "type": "custom",
    "sourcePosition": "right",
    "targetPosition": "left",
    "zIndex": 0,
    "width": 242,
    "height": 53,
    "selected": False,
    "position": {"x": 366.0, "y": -105.0},
    "positionAbsolute": {"x": 366.0, "y": -105.0},
    "data": {
        "type": "code",
        "title": "REFINER CHECK",
        "code_language": "python3",
        "code": CHECK_CODE,
        "variables": [
            {"variable": "arg1", "value_selector": [REFINER, "text"], "value_type": "string"},
        ],
        "outputs": {
            "status": {"type": "string", "children": None},
            "filters_json": {"type": "string", "children": None},
            "clarification": {"type": "string", "children": None},
            "message": {"type": "string", "children": None},
            "notes": {"type": "string", "children": None},
        },
        "selected": False,
    },
}

branch_node = {
    "id": BRANCH,
    "type": "custom",
    "sourcePosition": "right",
    "targetPosition": "left",
    "zIndex": 0,
    "width": 242,
    "height": 148,
    "selected": False,
    "position": {"x": 617.0, "y": -105.0},
    "positionAbsolute": {"x": 617.0, "y": -105.0},
    "data": {
        "type": "if-else",
        "title": "ЗАПРОС ПОНЯТЕН?",
        "cases": [
            {
                "case_id": "true",
                "id": "true",
                "logical_operator": "and",
                "conditions": [
                    {
                        "id": "0f1c2d34-refiner-status-ok",
                        "varType": "string",
                        "variable_selector": [CHECK, "status"],
                        "comparison_operator": "is",
                        "value": "ok",
                    },
                ],
            },
        ],
        "selected": False,
    },
}

end_clarify = {
    "id": END_CLARIFY,
    "type": "custom",
    "sourcePosition": "right",
    "targetPosition": "left",
    "zIndex": 0,
    "width": 242,
    "height": 106,
    "selected": False,
    "position": {"x": 880.0, "y": -230.0},
    "positionAbsolute": {"x": 880.0, "y": -230.0},
    "data": {
        "type": "end",
        "title": "Уточнение",
        "outputs": [
            {"variable": "clarification", "value_selector": [CHECK, "clarification"], "value_type": "string"},
            {"variable": "message", "value_selector": [CHECK, "message"], "value_type": "string"},
        ],
        "selected": False,
    },
}

# ----------------------------------------------------------------------
# ПОИСК БЕРЁТ ФИЛЬТРЫ У REFINER CHECK
# ----------------------------------------------------------------------

node[SEARCH]["data"]["body"]["data"][0]["value"] = "{{#%s.filters_json#}}" % CHECK
# Запасной список опрашивает цены Беларуси по одному: минута с лишним бывает.
node[SEARCH]["data"]["timeout"] = {"connect": 10, "read": 300, "max_connect_timeout": 0, "max_read_timeout": 0, "max_write_timeout": 0}

# ----------------------------------------------------------------------
# HTTP CHECK ОТДАЁТ САЙТУ meta.search
# ----------------------------------------------------------------------

check = node[HTTP_CHECK]["data"]

# Разбор ответа не трогаем: оборачиваем его и дописываем meta.search.
assert check["code"].lstrip().startswith("import json")
check["code"] = check["code"].replace("def main(arg1: str):", "def classify(arg1: str):", 1) + \
    '''

def main(arg1: str) -> dict:
    result = classify(arg1)

    # Как применён запрос: бюджет, запасной список, непроверенные комплектации.
    try:
        meta = (json.loads(arg1 or "{}") or {}).get("meta") or {}
        search = meta.get("search")
    except Exception:
        search = None

    result["search_meta"] = json.dumps(search, ensure_ascii=False) if isinstance(search, dict) else ""

    return result
'''

assert check["code"].count("def classify(arg1: str):") == 1
check["outputs"]["search_meta"] = {"type": "string", "children": None}

# ----------------------------------------------------------------------
# ВЫВОДЫ: и предупреждения, и как применён запрос
# ----------------------------------------------------------------------

node[END_NONE]["data"]["outputs"] = [
    {"variable": "message", "value_selector": [HTTP_CHECK, "message"], "value_type": "string"},
    {"variable": "search_meta", "value_selector": [HTTP_CHECK, "search_meta"], "value_type": "string"},
    {"variable": "notes", "value_selector": [CHECK, "notes"], "value_type": "string"},
]

node[END_FOUND]["data"]["outputs"] = [
    *node[END_FOUND]["data"]["outputs"],
    {"variable": "search_meta", "value_selector": [HTTP_CHECK, "search_meta"], "value_type": "string"},
    {"variable": "notes", "value_selector": [CHECK, "notes"], "value_type": "string"},
]

# ----------------------------------------------------------------------
# СВЯЗИ
# ----------------------------------------------------------------------

def edge(source, target, source_type, target_type, handle="source"):
    return {
        "id": f"{source}-{handle}-{target}-target",
        "type": "custom",
        "source": source,
        "sourceHandle": handle,
        "target": target,
        "targetHandle": "target",
        "zIndex": 0,
        "selected": False,
        "data": {"sourceType": source_type, "targetType": target_type, "isInIteration": False, "isInLoop": False},
    }


dropped = {(START, REFINER), (REFINER, SEARCH)}
edges = [e for e in graph["edges"] if (e["source"], e["target"]) not in dropped]

edges += [
    edge(START, VOCAB, "start", "http-request"),
    edge(VOCAB, REFINER, "http-request", "llm"),
    edge(REFINER, CHECK, "llm", "code"),
    edge(CHECK, BRANCH, "code", "if-else"),
    edge(BRANCH, SEARCH, "if-else", "http-request", "true"),
    edge(BRANCH, END_CLARIFY, "if-else", "end", "false"),
]

graph["nodes"] = [*graph["nodes"], vocab_node, check_node, branch_node, end_clarify]
graph["edges"] = edges

out = os.path.join(SP, "graph-v16.json")
json.dump(graph, open(out, "w"), ensure_ascii=False)
print("nodes", len(graph["nodes"]), "edges", len(graph["edges"]), "bytes", os.path.getsize(out))
print("search body:", node[SEARCH]["data"]["body"]["data"][0]["value"])
