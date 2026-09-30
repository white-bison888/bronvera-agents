"""
Добавляет промежуточным агентам требование писать коротко.

Что режем и почему именно это. Сайт читает ТОЛЬКО вывод ORCHESTRATOR
(data.summary, car.reason, car.mainAdvantages, car.mainRisks) и числа от
MAX BID. Вывод Selector, ASSESSOR и MARKET ANALYST не видит никто, кроме
следующего агента, — а платим мы за него дважды: как за выход у автора и как
за вход у ORCHESTRATOR. Выход при этом стоит впятеро дороже входа.

Поэтому краткость требуется только от трёх промежуточных узлов. ORCHESTRATOR
не трогаем: его текст читает человек, и укорачивать его — это менять выдачу.

Блок ограничен маркерами: повторный запуск заменяет, а не копит.

Запуск:
  python cap-verbosity.py <граф.json> <куда.json>

Публикация — publish-graph.py. После публикации обязателен smoke-test.sh:
если ORCHESTRATOR начнёт писать заметно беднее, правку надо откатить.
"""

import json
import re
import sys

BEGIN = "<!-- КРАТКОСТЬ:НАЧАЛО -->"
END = "<!-- КРАТКОСТЬ:КОНЕЦ -->"

TARGETS = ("Selector", "ASSESSOR", "MARKET ANALYST")

BLOCK = """ФОРМА ОТВЕТА: ТЕЛЕГРАФНО

Твой ответ читает только следующий агент, не человек. Всё, что ты пишешь,
оплачивается дважды — как твой выход и как его вход. Поэтому:

- в каждом списке оставляй не больше 3 пунктов, самых весомых;
- пункт — одна фраза до 140 символов, без вводных слов и без «важно отметить»;
- свободные поля (comment, damageAssessment и подобные) — до 300 символов;
- не пересказывай данные лота: следующий агент видит их сам;
- не объясняй ход своих рассуждений, если под это нет отдельного поля.

Состав полей JSON и их названия НЕ меняй — короче становится только текст
внутри них. Если фактов не хватает на 3 пункта, напиши меньше: добирать
пункты ради числа нельзя."""


def strip_block(text):
    return re.sub(re.escape(BEGIN) + r".*?" + re.escape(END), "", text, flags=re.S).rstrip()


if len(sys.argv) < 3:
    raise SystemExit(__doc__)

source, target = sys.argv[1], sys.argv[2]
graph = json.load(open(source))

touched = []
for node in graph["nodes"]:
    data = node["data"]
    if data.get("type") != "llm" or data.get("title") not in TARGETS:
        continue

    prompts = data.get("prompt_template") or []
    if not prompts:
        print(f"{data.get('title')}: нет prompt_template, пропускаю")
        continue

    first = prompts[0]
    before = first.get("text") or ""
    had = BEGIN in before
    first["text"] = strip_block(before) + "\n\n" + f"{BEGIN}\n{BLOCK}\n{END}"
    data["prompt_template"] = prompts

    touched.append((data["title"], "обновлён" if had else "добавлен"))

missing = set(TARGETS) - {t for t, _ in touched}
if missing:
    raise SystemExit(f"не нашёл узлы: {', '.join(sorted(missing))} — граф не тот или названия изменились")

json.dump(graph, open(target, "w"), ensure_ascii=False)

for title, what in touched:
    print(f"{title:<16} блок краткости {what}")
print(f"\nORCHESTRATOR не тронут — его текст читает человек")
print(f"узлов затронуто: {len(touched)} | всего узлов: {len(graph['nodes'])} | рёбер: {len(graph['edges'])}")
print(f"записано: {target}")
