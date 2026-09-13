"""Семантический разбор фотографий лота через GigaChat.

YOLO отвечает на вопрос «есть ли на снимке знакомый дефект». Этот модуль
отвечает на вопрос «что вообще с машиной»: сорванная крыша, открытый лонжерон,
сработавшие подушки — то, чего нет среди классов детектора.
"""

import json
import logging
import os
import re
import tempfile

logger = logging.getLogger(__name__)

CREDENTIALS = os.getenv('GIGACHAT_CREDENTIALS', '')
MODEL = os.getenv('GIGACHAT_MODEL', 'GigaChat-2-Max')
SCOPE = os.getenv('GIGACHAT_SCOPE', 'GIGACHAT_API_PERS')
# Sber подписывает сертификаты собственным УЦ, которого нет в системном хранилище.
VERIFY_SSL = os.getenv('GIGACHAT_VERIFY_SSL', 'false').lower() == 'true'
MAX_PHOTOS = int(os.getenv('GIGACHAT_MAX_PHOTOS', '4'))

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


def _extract_json(text):
    """Модель иногда оборачивает ответ в ```json ... ``` или добавляет текст."""
    match = re.search(r'\{.*\}', text, re.DOTALL)
    if not match:
        raise ValueError(f"в ответе нет JSON: {text[:200]}")
    return json.loads(match.group(0))


def analyze(images, lot_number="unknown"):
    """images — список bytes. Возвращает разбор по каждому снимку."""
    if not CREDENTIALS:
        return {"available": False, "reason": "GIGACHAT_CREDENTIALS не задан"}

    try:
        from gigachat import GigaChat
    except ImportError:
        return {"available": False, "reason": "пакет gigachat не установлен"}

    results = []
    try:
        with GigaChat(credentials=CREDENTIALS, scope=SCOPE, model=MODEL,
                      verify_ssl_certs=VERIFY_SSL, timeout=180) as client:
            for index, raw in enumerate(images[:MAX_PHOTOS]):
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
                    results.append(payload)

                except Exception as exc:
                    logger.error(f"GigaChat, лот {lot_number}, фото {index}: {exc}")
                    results.append({"photoIndex": index, "error": str(exc)})

    except Exception as exc:
        logger.error(f"GigaChat недоступен для лота {lot_number}: {exc}")
        return {"available": False, "reason": str(exc)}

    usable = [r for r in results if "error" not in r]
    if not usable:
        return {"available": False, "reason": "ни один снимок не разобран",
                "perPhoto": results}

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
        "model": MODEL,
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
