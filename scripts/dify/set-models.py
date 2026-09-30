"""
Ставит всем LLM-узлам графа заданную модель и temperature.

Зачем отдельный скрипт: `tune-models.py` был разовой правкой под 19.09 (он же
выбрасывал DECISION DESK). Этот — обычный инструмент: берёт граф, меняет модель
и temperature у ВСЕХ узлов типа llm, печатает таблицу «было → стало».

Почему temperature 0: при 0.7 состав отобранных лотов пляшет от прогона к
прогону при одной и той же схеме, и любое сравнение «до/после» становится
бессмысленным. Воспроизводимость — условие для измерения всего остального.

Запуск:
  python set-models.py <граф.json> <куда.json> [модель] [temperature]

По умолчанию — claude-sonnet-5 и 0.
Публикация — publish-graph.py.
"""

import json
import sys

if len(sys.argv) < 3:
    raise SystemExit(__doc__)

source, target = sys.argv[1], sys.argv[2]
model_name = sys.argv[3] if len(sys.argv) > 3 else "claude-sonnet-5"
temperature = float(sys.argv[4]) if len(sys.argv) > 4 else 0.0

graph = json.load(open(source))

changed = []
for node in graph["nodes"]:
    data = node["data"]
    if data.get("type") != "llm":
        continue

    model = dict(data.get("model") or {})
    params = dict(model.get("completion_params") or {})

    was = (model.get("name"), params.get("temperature"))

    model["name"] = model_name
    params["temperature"] = temperature
    model["completion_params"] = params
    data["model"] = model

    changed.append((data.get("title", "?"), was, (model_name, temperature)))

if not changed:
    raise SystemExit("в графе нет узлов типа llm — проверь, тот ли файл")

json.dump(graph, open(target, "w"), ensure_ascii=False)

width = max(len(title) for title, _, _ in changed)
for title, was, now in changed:
    print(f"{title:<{width}}  {was[0]} t={was[1]}  →  {now[0]} t={now[1]}")
print(f"\nузлов изменено: {len(changed)} | всего узлов: {len(graph['nodes'])} | рёбер: {len(graph['edges'])}")
print(f"записано: {target}")
