"""
Вшивает уроки из agents/lessons/*.md в промпты соответствующих узлов графа.

Почему вшиваем, а не подаём HTTP-узлом:
  • узел в графе — это ещё одна точка отказа на каждом прогоне и лишние
    секунды ожидания; уроки меняются раз в недели, а не в секунды;
  • вшитый текст видно в выгрузке `export-prompts.sh` — то есть на диске
    лежит ровно то, что читает модель;
  • топология графа не меняется, значит публикация не может разорвать рёбра.
Цена: обновление уроков = пересчёт + повторная публикация, одной командой.

Блок ограничен маркерами, поэтому повторный запуск ЗАМЕНЯЕТ прежние уроки,
а не копит их. Узел без файла уроков не трогается.

Запуск:
  python inject-lessons.py <граф.json> <куда.json> [папка-с-уроками]

Публикация — publish-graph.py.
"""

import json
import os
import re
import sys

BEGIN = "<!-- УРОКИ:НАЧАЛО -->"
END = "<!-- УРОКИ:КОНЕЦ -->"

# узел в Dify -> файл уроков
TARGETS = {
    "ASSESSOR": "assessor.md",
    "Selector": "selector.md",
    "MARKET ANALYST": "market-analyst.md",
}

if len(sys.argv) < 3:
    raise SystemExit(__doc__)

source, target = sys.argv[1], sys.argv[2]
lessons_dir = sys.argv[3] if len(sys.argv) > 3 else "agents/lessons"

graph = json.load(open(source))


def lesson_text(filename):
    path = os.path.join(lessons_dir, filename)
    if not os.path.exists(path):
        return None
    body = open(path, encoding="utf-8").read()
    # убираем служебный комментарий и заголовок файла — модели нужен только смысл
    body = re.sub(r"<!--.*?-->", "", body, flags=re.S)
    body = re.sub(r"^#\s+.*$", "", body, flags=re.M)
    # Строку «Снято <дата> по N парам из M записей» в промпт не несём: дата
    # меняется ежедневно, и блок выглядел бы новым каждый день — таймер
    # публиковал бы граф впустую. Сколько лотов за уроком, сказано в самих
    # пунктах («122 лотов»), а дата остаётся в файле для человека.
    body = re.sub(r"^Снято .*?записей истории\.\s*$", "", body, flags=re.M | re.S)
    body = body.strip()
    if not body:
        return None
    return (
        "ЧЕМУ НАУЧИЛА ИСТОРИЯ ПРОГНОЗОВ\n\n"
        "Ниже — расхождения наших прошлых прогнозов с фактическими ценами продажи. "
        "Это поправка к твоим оценкам, а не данные о текущем лоте. "
        "Не ссылайся на эти цифры в ответе и не подставляй их вместо расчёта.\n\n"
        f"{body}"
    )


def strip_block(text):
    return re.sub(
        re.escape(BEGIN) + r".*?" + re.escape(END),
        "",
        text,
        flags=re.S,
    ).rstrip()


touched = []
for node in graph["nodes"]:
    data = node["data"]
    if data.get("type") != "llm":
        continue

    title = data.get("title")
    if title not in TARGETS:
        continue

    lesson = lesson_text(TARGETS[title])
    if not lesson:
        print(f"{title}: уроков нет, пропускаю")
        continue

    block = f"{BEGIN}\n{lesson}\n{END}"

    prompts = data.get("prompt_template") or []
    if not prompts:
        print(f"{title}: нет prompt_template, пропускаю")
        continue

    # уроки идут в первое сообщение — это системная часть промпта
    first = prompts[0]
    before = first.get("text") or ""
    was = re.search(re.escape(BEGIN) + r".*?" + re.escape(END), before, flags=re.S)
    same = bool(was) and was.group(0) == block

    first["text"] = strip_block(before) + "\n\n" + block
    data["prompt_template"] = prompts

    if was is None:
        what = "добавлен"
    elif same:
        what = "не изменился"
    else:
        what = "обновлён"
    touched.append((title, len(lesson), what))

if not touched:
    raise SystemExit("ни в один узел уроки не попали — проверь папку с уроками и названия узлов")

json.dump(graph, open(target, "w"), ensure_ascii=False)

width = max(len(t) for t, _, _ in touched)
for title, size, what in touched:
    print(f"{title:<{width}}  блок {what}, {size} символов (≈{size // 4} токенов входа)")
print(f"\nузлов затронуто: {len(touched)} | всего узлов: {len(graph['nodes'])} | рёбер: {len(graph['edges'])}")
print(f"записано: {target}")

# Сравнивать графы побайтно нельзя: мы снимаем блок и дописываем его в конец,
# из-за чего порядок блоков в промпте может измениться при том же тексте.
# Поэтому о «ничего не поменялось» сообщаем кодом возврата 2 — на него смотрит
# refresh-lessons.sh, чтобы не публиковать граф впустую.
if all(what == "не изменился" for _, _, what in touched):
    print("\nуроки те же, что уже вшиты")
    sys.exit(2)
