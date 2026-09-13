"""Семантический разбор фотографий лота.

YOLO отвечает на вопрос «есть ли на снимке знакомый дефект». Этот модуль
отвечает на вопрос «что вообще с машиной»: сорванная крыша, открытый лонжерон,
сработавшие подушки — то, чего нет среди классов детектора.

Поставщик выбирается переменной VISION_PROVIDER: gemini или gigachat.
"""

import datetime
import json
import logging
import os
import re
import tempfile
import threading
import time

logger = logging.getLogger(__name__)

RETRY_ATTEMPTS = int(os.getenv('VISION_RETRY_ATTEMPTS', '4'))
# Бесплатный лимит Gemini регулярно отвечает 503 «высокая нагрузка».
TRANSIENT = ('503', '429', 'UNAVAILABLE', 'RESOURCE_EXHAUSTED', 'timeout', 'DEADLINE')

# Ограничители на нашей стороне. Держим ниже тарифных потолков (15 в минуту,
# 500 в сутки у Flash Lite), чтобы упираться в свой предел, а не ловить отказы.
RPM_LIMIT = int(os.getenv('VISION_RPM_LIMIT', '12'))
DAILY_LIMIT = int(os.getenv('VISION_DAILY_LIMIT', '450'))

_throttle = threading.Lock()
_last_call = 0.0
_day = None
_spent_today = 0


class BudgetExhausted(Exception):
    pass


def _reserve_slot():
    """Держит темп запросов и суточный расход в заданных рамках."""
    global _last_call, _day, _spent_today

    with _throttle:
        today = datetime.date.today()
        if today != _day:
            _day, _spent_today = today, 0

        if _spent_today >= DAILY_LIMIT:
            raise BudgetExhausted(
                f"суточный лимит исчерпан: {_spent_today} из {DAILY_LIMIT}")

        wait = (_last_call + 60.0 / RPM_LIMIT) - time.monotonic()
        if wait > 0:
            time.sleep(wait)

        _last_call = time.monotonic()
        _spent_today += 1


def budget_status():
    with _throttle:
        used = _spent_today if datetime.date.today() == _day else 0
    return {"usedToday": used, "dailyLimit": DAILY_LIMIT, "rpmLimit": RPM_LIMIT}

PROVIDER = os.getenv('VISION_PROVIDER', 'gemini').lower()
MAX_PHOTOS = int(os.getenv('VISION_MAX_PHOTOS', '4'))

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

PROMPT = """Ты осматриваешь фотографию автомобиля с аукциона битых машин.

Опиши только то, что видно на снимке. Ничего не додумывай.

Особое внимание обрати на тяжёлые повреждения, которые легко упустить:
отсутствие крыши, стойки или целой панели кузова, разрыв кузова,
открытые силовые элементы (лонжероны, подрамник), следы огня,
следы затопления, сработавшие подушки безопасности в салоне.

Верни СТРОГО JSON без markdown и пояснений, по этой схеме:
{
  "visibleDamage": ["краткие описания увиденных повреждений"],
  "damageZones": ["зоны: перед, зад, левый борт, правый борт, крыша, салон, днище"],
  "severity": "light | moderate | severe",
  "structuralConcern": "описание, если видны силовые элементы или деформация кузова, иначе null",
  "missingParts": ["детали, которых физически нет на месте"],
  "airbagsDeployed": true | false | null,
  "batteryAreaAffected": true | false | null,
  "fireOrFloodSigns": "описание следов огня или воды, иначе null",
  "confidence": 0.0,
  "notes": "один-два предложения общего вывода"
}

null означает «на этом снимке не определить». Не подменяй его значением false:
отсутствие обзора и отсутствие повреждения — разные вещи."""


def _with_retry(call, label):
    delay = 2
    for attempt in range(1, RETRY_ATTEMPTS + 1):
        try:
            return call()
        except Exception as exc:
            message = str(exc)
            transient = any(marker in message for marker in TRANSIENT)
            if not transient or attempt == RETRY_ATTEMPTS:
                raise
            logger.warning(
                f"{label}: попытка {attempt} из {RETRY_ATTEMPTS} не удалась, "
                f"жду {delay}с — {message[:120]}")
            time.sleep(delay)
            delay *= 2


def _extract_json(text):
    """Модель иногда оборачивает ответ в ```json ... ``` или добавляет текст."""
    match = re.search(r'\{.*\}', text, re.DOTALL)
    if not match:
        raise ValueError(f"в ответе нет JSON: {text[:200]}")
    return json.loads(match.group(0))


def _gemini_call(images):
    from google import genai
    from google.genai import types

    client = genai.Client(api_key=GEMINI_KEY)
    config = types.GenerateContentConfig(
        temperature=0.1,
        response_mime_type="application/json",
    )

    models = [m for m in (GEMINI_MODEL, GEMINI_FALLBACK) if m]

    out = []
    for index, raw in enumerate(images):
        part = types.Part.from_bytes(data=raw, mime_type="image/jpeg")
        last_error = None

        for model_name in models:
            try:
                def attempt(m=model_name):
                    _reserve_slot()
                    return client.models.generate_content(
                        model=m, contents=[part, PROMPT], config=config)

                response = _with_retry(attempt, f"Gemini {model_name}, фото {index}")
                payload = _extract_json(response.text)
                payload["photoIndex"] = index
                payload["model"] = model_name
                out.append(payload)
                break
            except BudgetExhausted as exc:
                # Запасная модель тратит тот же бюджет — перебирать смысла нет.
                logger.warning(f"Gemini, фото {index}: {exc}")
                out.append({"photoIndex": index, "error": str(exc)})
                return out
            except Exception as exc:
                last_error = exc
                logger.error(f"Gemini {model_name}, фото {index}: {exc}")
        else:
            out.append({"photoIndex": index, "error": str(last_error)})

    return out


def _gigachat_call(images):
    from gigachat import GigaChat

    out = []
    with GigaChat(credentials=GIGACHAT_CREDENTIALS, scope=GIGACHAT_SCOPE,
                  model=GIGACHAT_MODEL, verify_ssl_certs=GIGACHAT_VERIFY_SSL,
                  timeout=180) as client:
        for index, raw in enumerate(images):
            try:
                with tempfile.NamedTemporaryFile(suffix=".jpg") as tmp:
                    tmp.write(raw)
                    tmp.flush()
                    tmp.seek(0)
                    uploaded = client.upload_file(tmp, purpose="general")

                answer = client.chat({
                    "messages": [{
                        "role": "user",
                        "content": PROMPT,
                        "attachments": [uploaded.id_],
                    }],
                    "temperature": 0.1,
                })
                payload = _extract_json(answer.choices[0].message.content)
                payload["photoIndex"] = index
                out.append(payload)
            except Exception as exc:
                logger.error(f"GigaChat, фото {index}: {exc}")
                out.append({"photoIndex": index, "error": str(exc)})
    return out


PROVIDERS = {
    'gemini': (_gemini_call, lambda: bool(GEMINI_KEY), 'GEMINI_API_KEY не задан', GEMINI_MODEL),
    'gigachat': (_gigachat_call, lambda: bool(GIGACHAT_CREDENTIALS),
                 'GIGACHAT_CREDENTIALS не задан', GIGACHAT_MODEL),
}


def analyze(images, lot_number="unknown"):
    """images — список bytes. Возвращает сводный разбор по всем снимкам."""
    provider = PROVIDERS.get(PROVIDER)
    if provider is None:
        return {"available": False, "reason": f"неизвестный VISION_PROVIDER: {PROVIDER}"}

    call, configured, missing_reason, model_name = provider
    if not configured():
        return {"available": False, "reason": missing_reason}

    try:
        results = call(images[:MAX_PHOTOS])
    except Exception as exc:
        logger.error(f"{PROVIDER} недоступен для лота {lot_number}: {exc}")
        return {"available": False, "provider": PROVIDER, "reason": str(exc)}

    usable = [r for r in results if "error" not in r]
    if not usable:
        return {"available": False, "provider": PROVIDER,
                "reason": "ни один снимок не разобран", "perPhoto": results}

    order = {"light": 0, "moderate": 1, "severe": 2}
    severities = [r.get("severity") for r in usable if r.get("severity") in order]

    def collect(field):
        merged = []
        for r in usable:
            for item in r.get(field) or []:
                if item not in merged:
                    merged.append(item)
        return merged

    def worst(field):
        # true важнее null, null важнее false: подушки, замеченные хотя бы
        # на одном снимке, остаются фактом, даже если на других их не видно.
        values = [r.get(field) for r in usable]
        if True in values:
            return True
        return False if all(v is False for v in values) else None

    return {
        "available": True,
        "provider": PROVIDER,
        "model": model_name,
        "photosAnalyzed": len(usable),
        "visibleDamage": collect("visibleDamage"),
        "damageZones": collect("damageZones"),
        "missingParts": collect("missingParts"),
        "severity": max(severities, key=lambda s: order[s]) if severities else None,
        "structuralConcern": next(
            (r["structuralConcern"] for r in usable if r.get("structuralConcern")), None),
        "fireOrFloodSigns": next(
            (r["fireOrFloodSigns"] for r in usable if r.get("fireOrFloodSigns")), None),
        "airbagsDeployed": worst("airbagsDeployed"),
        "batteryAreaAffected": worst("batteryAreaAffected"),
        "confidence": round(
            sum(float(r.get("confidence") or 0) for r in usable) / len(usable), 2),
        "notes": " ".join(r["notes"] for r in usable if r.get("notes"))[:1000],
        "perPhoto": results,
    }
