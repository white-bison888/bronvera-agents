"""
Заменяет код узла типа `code` в графе Dify на содержимое файла.

Зачем: код узлов правится мышью в веб-интерфейсе, из-за чего его негде
посмотреть в истории и нечем проверить. Файлы в scripts/dify/nodes/ — источник
истины для кода узлов, этот скрипт переносит их в граф.

Проверяет главное перед записью: что новый код компилируется и что в нём есть
функция main. Узел с битым кодом валит весь прогон.

Запуск:
  python patch-node-code.py <граф.json> <куда.json> "<название узла>" <файл.py>
"""

import ast
import json
import sys

if len(sys.argv) < 5:
    raise SystemExit(__doc__)

source, target, node_title, code_file = sys.argv[1], sys.argv[2], sys.argv[3], sys.argv[4]

new_code = open(code_file, encoding="utf-8").read()

try:
    tree = ast.parse(new_code)
except SyntaxError as error:
    raise SystemExit(f"{code_file}: код не компилируется — {error}")

if not any(isinstance(node, ast.FunctionDef) and node.name == "main" for node in tree.body):
    raise SystemExit(f"{code_file}: нет функции main — Dify такой узел не запустит")

graph = json.load(open(source))

found = None
for node in graph["nodes"]:
    data = node["data"]
    if data.get("title") != node_title:
        continue
    if data.get("type") != "code":
        raise SystemExit(f"узел «{node_title}» имеет тип {data.get('type')}, а не code")
    found = data
    break

if found is None:
    titles = sorted(n["data"].get("title", "?") for n in graph["nodes"] if n["data"].get("type") == "code")
    raise SystemExit(f"узел «{node_title}» не найден. Узлы с кодом: {', '.join(titles)}")

was = found.get("code") or ""
found["code"] = new_code

json.dump(graph, open(target, "w"), ensure_ascii=False)

print(f"узел «{node_title}»: код {len(was)} → {len(new_code)} символов")
print(f"всего узлов: {len(graph['nodes'])} | рёбер: {len(graph['edges'])}")
print(f"записано: {target}")
