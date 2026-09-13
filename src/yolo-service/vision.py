"""Разбор фотографий лота моделью, понимающей содержимое снимка.

Детектор отвечает на вопрос «есть ли на снимке знакомый дефект». Здесь
отвечаем на вопрос «что вообще с машиной»: сорванная крыша, открытый
лонжерон, сработавшие подушки, ржавчина — всё, чего нет среди его классов.

Все снимки лота уходят одним запросом. По отдельности стоимость ремонта
посчитать нельзя: одно и то же крыло, попавшее в три кадра, будет оплачено
трижды. Плюс это один запрос на лот вместо десяти — при суточном лимите
бесплатного тарифа разница решающая.

Поставщик выбирается переменной VISION_PROVIDER: gemini или gigachat.
"""

import datetime
import io
import json
import logging
import os
import re
import tempfile
import threading
import time

from PIL import Image

logger = logging.getLogger(__name__)

PROVIDER = os.getenv('VISION_PROVIDER', 'gemini').lower()

GEMINI_KEY = os.getenv('GEMINI_API_KEY', '')
# Lite основная не по качеству, а по суточному лимиту бесплатного тарифа:
# у Flash это 20 запросов в день, у Lite — 500. Flash остаётся запасной.
GEMINI_MODEL = os.getenv('GEMINI_MODEL', 'gemini-flash-lite-latest')
GEMINI_FALLBACK = os.getenv('GEMINI_FALLBACK_MODEL', 'gemini-flash-latest')

GIGACHAT_CREDENTIALS = os.getenv('GIGACHAT_CREDENTIALS', '')
GIGACHAT_MODEL = os.getenv('GIGACHAT_MODEL', 'GigaChat-2-Max')
GIGACHAT_SCOPE = os.getenv('GIGACHAT_SCOPE', 'GIGACHAT_API_PERS')
# Sber подписывает сертификаты собственным УЦ, которого нет в системном хранилище.
GIGACHAT_VERIFY_SSL = os.getenv('GIGACHAT_VERIFY_SSL', 'false').lower() == 'true'

RETRY_ATTEMPTS = int(os.getenv('VISION_RETRY_ATTEMPTS', '4'))
# Бесплатный лимит регулярно отвечает 503 «высокая нагрузка».
TRANSIENT = ('503', '429', 'UNAVAILABLE', 'RESOURCE_EXHAUSTED', 'timeout', 'DEADLINE')

# Держим ниже тарифных потолков (15 в минуту, 500 в сутки у Flash Lite),
# чтобы упираться в свой предел, а не ловить отказы.
RPM_LIMIT = int(os.getenv('VISION_RPM_LIMIT', '12'))
DAILY_LIMIT = int(os.getenv('VISION_DAILY_LIMIT', '450'))
STATE_PATH = os.getenv('VISION_STATE_PATH', '/data/vision-budget.json')

# Снимки аукциона бывают по 4000 пикселей. Для разбора повреждений столько
# не нужно, а вес запроса и расход токенов растут заметно.
MAX_EDGE = int(os.getenv('VISION_MAX_EDGE', '1280'))
MAX_PHOTOS = int(os.getenv('VISION_MAX_PHOTOS', '0'))  # 0 — без ограничения

PROMPT = """Ты — технический эксперт по аварийным автомобилям с аукционов США.

Тебе показывают все фотографии одного лота. Оцени повреждения ТОЛЬКО по тому,
что реально видно на снимках.

Правила:
— не выдумывай повреждения, которых не видно;
— если ракурсов не хватает, честно снижай уверенность;
— различай косметику (бампер, крыло, оптика) и силовые элементы
  (лонжероны, стойки, порог, подрамник, крыша);
— для электромобилей отдельно отмечай риск для батареи и её корпуса;
— срабатывание подушек отмечай, только если виден салон.

Отдельно ищи тяжёлое, что легко упустить: отсутствие крыши, стойки или целой
панели, разрыв кузова, открытые силовые элементы, следы огня, следы воды,
сильную коррозию.

ЕСЛИ СНИМКИ НЕПРИГОДНЫ

Бывает, что вместо фотографии приходит пустой кадр, заглушка или снимок,
на котором автомобиля не видно. Тогда НЕ УГАДЫВАЙ. Верни ровно такой ответ:

{ "photosUsable": false, "notes": "что именно не так со снимками" }

Во всех остальных случаях ставь "photosUsable": true и заполняй полный ответ.

Верни СТРОГО JSON без markdown и без текста вокруг:

{
  "photosUsable": true,
  "visibleDamage": ["перечень видимых повреждений"],
  "damageZones": ["front|rear|left|right|roof|underbody|interior"],
  "missingParts": ["детали, которых физически нет на месте"],
  "severity": "light|moderate|severe",
  "structuralConcern": true,
  "airbagsDeployed": true,
  "batteryAreaAffected": true,
  "fireOrFloodSigns": "описание следов огня или воды, иначе null",
  "rustSeverity": "none|light|moderate|severe",
  "repairPlan": [
    {
      "work": "что именно делать",
      "partsUsd": 0,
      "laborUsd": 0,
      "note": "почему это нужно — что видно на снимке"
    }
  ],
  "repairCostMin": 0,
  "repairCostMax": 0,
  "confidence": "high|medium|low",
  "notes": "краткий технический вывод"
}

Для полей structuralConcern, airbagsDeployed и batteryAreaAffected значение
null означает «по этим снимкам не определить». Не подменяй его значением
false: отсутствие обзора и отсутствие повреждения — разные вещи.

ГДЕ И ПО КАКИМ ЦЕНАМ СЧИТАТЬ РЕМОНТ

Автомобиль покупается на аукционе США и восстанавливается в Польше,
поэтому считай так:

— ЗАПЧАСТИ по ценам мирового рынка в долларах. Для Tesla учитывай,
  что оригинальные кузовные детали дороги, а на распространённые модели
  есть неоригинал и разборка;

— РАБОТА по польским ставкам: примерно 25-40 USD за нормо-час
  в обычном сервисе, 50-70 USD в специализированном по электромобилям.
  Это в два-три раза дешевле американских ставок — не считай по США;

— покраска элемента в Польше обычно 120-250 USD за деталь;

— работы с высоковольтной батареей и её корпусом считай по ставкам
  специализированного сервиса.

repairPlan — перечень конкретных работ. По каждой строке указывай
стоимость запчастей и работы отдельно, чтобы оценку можно было
проверить и оспорить. Не пиши общие фразы вроде «кузовной ремонт» —
называй узлы: бампер, крыло, лонжерон, стойка, дверь, порог.

repairCostMin и repairCostMax — итоговый диапазон по всем работам
из repairPlan, в долларах. Минимум считай при благоприятном сценарии
(скрытых повреждений нет, детали с разборки), максимум — при
неблагоприятном (нужны новые оригинальные детали, повреждения глубже).

Если повреждение лёгкое и хорошо видно, диапазон обязателен.
Ставь null только когда снимков действительно не хватает даже
для грубой оценки — но тогда объясни в notes, чего именно не видно.

Тексты в visibleDamage, repairPlan и notes пиши по-русски."""


class BudgetExhausted(Exception):
    pass


_lock = threading.Lock()
_last_call = 0.0


def _load_state():
    try:
        with open(STATE_PATH) as handle:
            return json.load(handle)
    except (OSError, ValueError):
        return {}


def _save_state(state):
    try:
        os.makedirs(os.path.dirname(STATE_PATH), exist_ok=True)
        with open(STATE_PATH, 'w') as handle:
            json.dump(state, handle)
    except OSError as exc:
        # Расход важнее счётчика: не срываем разбор из-за проблем с диском.
        logger.error(f"не удалось сохранить счётчик расхода: {exc}")


def _reserve_slot():
    """Держит темп запросов и суточный расход в заданных рамках.

    Счётчик лежит на диске: контейнер перезапускают, а лимит у Google
    суточный, и после рестарта отсчёт с нуля упёрся бы в их отказ.
    """
    global _last_call

    with _lock:
        today = datetime.date.today().isoformat()
        state = _load_state()
        used = state.get('used', 0) if state.get('day') == today else 0

        if used >= DAILY_LIMIT:
            raise BudgetExhausted(
                f"суточный лимит исчерпан: {used} из {DAILY_LIMIT}, "
                f"разбор перенесён на следующий день")

        wait = (_last_call + 60.0 / RPM_LIMIT) - time.monotonic()
        if wait > 0:
            time.sleep(wait)

        _last_call = time.monotonic()
        _save_state({'day': today, 'used': used + 1})


def budget_status():
    today = datetime.date.today().isoformat()
    state = _load_state()
    used = state.get('used', 0) if state.get('day') == today else 0
    return {
        "usedToday": used,
        "dailyLimit": DAILY_LIMIT,
        "remaining": max(0, DAILY_LIMIT - used),
        "rpmLimit": RPM_LIMIT,
    }


def _with_retry(call, label):
    delay = 2
    for attempt in range(1, RETRY_ATTEMPTS + 1):
        try:
            return call()
        except Exception as exc:
            message = str(exc)
            if not any(m in message for m in TRANSIENT) or attempt == RETRY_ATTEMPTS:
                raise
            logger.warning(
                f"{label}: попытка {attempt} из {RETRY_ATTEMPTS} не удалась, "
                f"жду {delay}с — {message[:120]}")
            time.sleep(delay)
            delay *= 2


def _extract_json(text):
    """Модель иногда оборачивает ответ в ```json ... ``` или добавляет текст."""
    match = re.search(r'\{.*\}', str(text or ''), re.DOTALL)
    if not match:
        raise ValueError(f"в ответе нет JSON: {str(text)[:200]}")
    return json.loads(match.group(0))


def _shrink(raw):
    """Ужимает снимок до разумного размера, сохраняя пропорции."""
    try:
        img = Image.open(io.BytesIO(raw)).convert("RGB")
        if max(img.size) > MAX_EDGE:
            img.thumbnail((MAX_EDGE, MAX_EDGE), Image.LANCZOS)
        buffer = io.BytesIO()
        img.save(buffer, format="JPEG", quality=85)
        return buffer.getvalue()
    except Exception as exc:
        logger.warning(f"снимок не удалось ужать, отправляю как есть: {exc}")
        return raw


def _gemini_call(images, context):
    from google import genai
    from google.genai import types

    client = genai.Client(api_key=GEMINI_KEY)
    config = types.GenerateContentConfig(
        temperature=0.1,
        response_mime_type="application/json",
    )
    parts = [types.Part.from_bytes(data=raw, mime_type="image/jpeg") for raw in images]
    parts.append(f"{context}\n\n{PROMPT}")

    last_error = None
    for model_name in [m for m in (GEMINI_MODEL, GEMINI_FALLBACK) if m]:
        try:
            def attempt(m=model_name):
                _reserve_slot()
                return client.models.generate_content(
                    model=m, contents=parts, config=config)

            response = _with_retry(attempt, f"Gemini {model_name}")
            return _extract_json(response.text), model_name
        except BudgetExhausted:
            # Запасная модель тратит тот же бюджет — перебирать смысла нет.
            raise
        except Exception as exc:
            last_error = exc
            logger.error(f"Gemini {model_name}: {exc}")

    raise last_error


def _gigachat_call(images, context):
    from gigachat import GigaChat

    with GigaChat(credentials=GIGACHAT_CREDENTIALS, scope=GIGACHAT_SCOPE,
                  model=GIGACHAT_MODEL, verify_ssl_certs=GIGACHAT_VERIFY_SSL,
                  timeout=300) as client:
        attachments = []
        for raw in images:
            with tempfile.NamedTemporaryFile(suffix=".jpg") as tmp:
                tmp.write(raw)
                tmp.flush()
                tmp.seek(0)
                attachments.append(client.upload_file(tmp, purpose="general").id_)

        def attempt():
            _reserve_slot()
            return client.chat({
                "messages": [{
                    "role": "user",
                    "content": f"{context}\n\n{PROMPT}",
                    "attachments": attachments,
                }],
                "temperature": 0.1,
            })

        answer = _with_retry(attempt, "GigaChat")
        return _extract_json(answer.choices[0].message.content), GIGACHAT_MODEL


PROVIDERS = {
    'gemini': (_gemini_call, lambda: bool(GEMINI_KEY), 'GEMINI_API_KEY не задан'),
    'gigachat': (_gigachat_call, lambda: bool(GIGACHAT_CREDENTIALS),
                 'GIGACHAT_CREDENTIALS не задан'),
}


def analyze(images, lot_number="unknown", context=""):
    """Разбирает все снимки лота одним запросом.

    Возвращает либо {available: True, assessment: {...}}, либо
    {available: False, reason, deferred}. Частичного разбора не бывает:
    половина осмотренных снимков может не содержать сорванной крыши,
    и лот прошёл бы как чистый.
    """
    provider = PROVIDERS.get(PROVIDER)
    if provider is None:
        return {"available": False, "reason": f"неизвестный VISION_PROVIDER: {PROVIDER}"}

    call, configured, missing_reason = provider
    if not configured():
        return {"available": False, "reason": missing_reason}

    if not images:
        return {"available": False, "reason": "снимки не переданы"}

    selected = images[:MAX_PHOTOS] if MAX_PHOTOS > 0 else images
    prepared = [_shrink(raw) for raw in selected]

    try:
        assessment, model_name = call(prepared, context)
    except BudgetExhausted as exc:
        logger.warning(f"лот {lot_number}: {exc}")
        # deferred — сигнал очереди отложить лот, а не признать его чистым.
        return {"available": False, "deferred": True, "reason": str(exc)}
    except Exception as exc:
        logger.error(f"{PROVIDER} не справился с лотом {lot_number}: {exc}")
        return {"available": False, "reason": str(exc)}

    if assessment.get("photosUsable") is False:
        return {
            "available": False,
            "provider": PROVIDER,
            "model": model_name,
            "reason": f"снимки непригодны: {assessment.get('notes') or 'содержимое не распознано'}",
        }

    return {
        "available": True,
        "provider": PROVIDER,
        "model": model_name,
        "photosAnalyzed": len(prepared),
        "assessment": assessment,
    }
