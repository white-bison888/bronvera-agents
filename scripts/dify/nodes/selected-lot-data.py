import json
import re

# Поля лота, которые реально нужны агентам. Всё остальное — служебное
# (метки времени обхода, статусы фильтра) или бесполезное: в `images`
# у bid.cars лежат не снимки машины, а иконки интерфейса (key.svg, timer.svg).
# Этот же объект уходит в ASSESSOR, MARKET ANALYST и ORCHESTRATOR, поэтому
# каждое лишнее поле оплачивается трижды за прогон.
KEEP = (
    "lotNumber", "vin", "make", "model", "year", "trim",
    "mileage", "currentBid", "buyNowUsd",
    "primaryDamage", "secondaryDamage",
    "keyPresence", "runAndDrive", "titleType",
    "auction", "seller", "location",
    "fuelType", "driveType", "transmission",
    "saleDate", "auctionEstimateMin", "auctionEstimateMax",
    "url",
)


def extract_json_object(text: str):
    if not text:
        return {}

    # Удаляем блоки <think>...</think>
    cleaned = re.sub(
        r"<think>.*?</think>",
        "",
        text,
        flags=re.DOTALL | re.IGNORECASE
    ).strip()

    # Если после очистки это уже валидный JSON
    try:
        return json.loads(cleaned)
    except Exception:
        pass

    # Запасной вариант:
    # берём содержимое от первой { до последней }
    start = cleaned.find("{")
    end = cleaned.rfind("}")

    if start != -1 and end != -1 and end > start:
        return json.loads(cleaned[start:end + 1])

    raise ValueError("Не удалось извлечь JSON из ответа SELECTOR")


def squeeze_bids(history):
    """Полная история ставок с метками времени агентам не нужна, но сигнал в
    ней есть: резкий сброс цены выдаёт ре-лист лота. Оставляем то, по чему
    этот сигнал виден, — первую, последнюю, край диапазона и число записей."""
    if not isinstance(history, list):
        return None

    values = []
    for item in history:
        if not isinstance(item, dict):
            continue
        value = item.get("value")
        if value is None:
            value = item.get("bid")
        if isinstance(value, (int, float)):
            values.append(value)

    if not values:
        return None

    squeezed = {"first": values[0], "last": values[-1], "points": len(values)}
    if min(values) != squeezed["first"] or max(values) != squeezed["last"]:
        squeezed["min"] = min(values)
        squeezed["max"] = max(values)
    return squeezed


def slim_listing(listing):
    if not isinstance(listing, dict):
        return listing

    slim = {}
    for key in KEEP:
        value = listing.get(key)
        # Пустое поле молчит красноречивее, чем "null": модель и так видит,
        # что его нет, а токены за него платятся.
        if value is None or value == "" or value == "---":
            continue
        slim[key] = value

    bids = squeeze_bids(listing.get("bidHistory"))
    if bids:
        slim["bidSummary"] = bids

    return slim


def main(selector_json: str, http_body: str, run_id: str = "") -> dict:
    try:
        selector_data = extract_json_object(selector_json)
        http_data = json.loads(http_body)

        selected = selector_data.get("selected", [])
        listings = http_data.get("listings", [])

        listing_map = {
            str(item.get("lotNumber")): item
            for item in listings
            if item.get("lotNumber") is not None
        }

        selected_lots = []

        for selector_item in selected:
            lot_number = str(selector_item.get("lotNumber") or "")

            if lot_number in listing_map:
                # vin уже есть в listing — во втором месте он только платный.
                selector_slim = {
                    k: v for k, v in selector_item.items()
                    if k != "vin" and v is not None
                }
                selected_lots.append({
                    "selector": selector_slim,
                    "listing": slim_listing(listing_map[lot_number])
                })

        # Номер прогона — бэкенд записывает на этот поиск расход на сбор и разбор фото.
        result = {
            "count": len(selected_lots),
            "selectedLots": selected_lots,
            "runId": run_id
        }

        return {
            "selected_lots_json": json.dumps(
                result,
                ensure_ascii=False
            ),
            "selected_lots": selected_lots
        }

    except Exception as e:
        error_result = {
            "count": 0,
            "selectedLots": [],
            "runId": run_id,
            "error": str(e)
        }

        return {
            "selected_lots_json": json.dumps(
                error_result,
                ensure_ascii=False
            ),
            "selected_lots": []
        }
