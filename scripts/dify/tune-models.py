"""
Две правки схемы, которые заметно дешевле не делают её хуже (проверено
прогонами 19.09.2026):

  v17 — убран узел DECISION DESK вместе с выходом «Вывод 3». Он писал свой
        вердикт в выход `result`, которого сайт не читает: 13% стоимости
        каждого поиска уходило в никуда.
  v18 — QUERY REFINER, Selector и MARKET ANALYST переведены на
        claude-sonnet-5. ASSESSOR и ORCHESTRATOR остались на Opus: от них
        зависит стоимость ремонта и итоговые заключения.

Запуск: python tune-models.py <граф.json> <куда-v17.json> <куда-v18.json>
Публикация — publish-graph.py.
"""

import json
import sys

source, out17, out18 = sys.argv[1], sys.argv[2], sys.argv[3]
graph = json.load(open(source))

DROP = {"DECISION DESK", "Вывод 3"}
SONNET = {"QUERY REFINER", "Selector", "MARKET ANALYST"}

titles = {node["id"]: node["data"].get("title") for node in graph["nodes"]}
drop = {node_id for node_id, title in titles.items() if title in DROP}

graph["nodes"] = [node for node in graph["nodes"] if node["id"] not in drop]
graph["edges"] = [edge for edge in graph["edges"] if edge["source"] not in drop and edge["target"] not in drop]

json.dump(graph, open(out17, "w"), ensure_ascii=False)
print("v17: узлов", len(graph["nodes"]), "| убрано", sorted(titles[i] for i in drop))

for node in graph["nodes"]:
    data = node["data"]

    if data.get("type") == "llm" and data["title"] in SONNET:
        data["model"] = {**data["model"], "name": "claude-sonnet-5"}

json.dump(graph, open(out18, "w"), ensure_ascii=False)
print("v18: на sonnet —", sorted(SONNET))
