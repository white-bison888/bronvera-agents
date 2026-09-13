#!/usr/bin/env python3
"""
YOLO v8 Photo Assessment Service
Детектирует повреждения авто: вмятины, ржавчина, разбитое стекло
"""

import os
import base64
import json
from io import BytesIO
from flask import Flask, request, jsonify
from flask_cors import CORS
from ultralytics import YOLO
from PIL import Image
import logging

import vision

app = Flask(__name__)
CORS(app)

# Логирование
logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

MODEL_PATH = os.getenv('MODEL_PATH', '/app/car-damage.pt')
CONF_THRESHOLD = float(os.getenv('CONF_THRESHOLD', '0.35'))

try:
    model = YOLO(MODEL_PATH)
    logger.info(f"✅ Модель загружена: {MODEL_PATH}, классы: {model.names}")
except Exception as e:
    logger.error(f"❌ Ошибка загрузки модели: {e}")
    model = None

# Классы дообученной модели car-dd → русские названия
DAMAGE_CLASSES = {
    'dent': 'вмятина',
    'scratch': 'царапина',
    'crack': 'трещина',
    'glass shatter': 'разбитое стекло',
    'lamp broken': 'разбитая фара',
    'tire flat': 'спущенное колесо',
}

def assess_photo(image_data, lot_number="unknown"):
    """
    Анализирует фото с помощью YOLO

    Args:
        image_data: bytes изображения или base64 строка
        lot_number: номер лота для логирования

    Returns:
        dict с результатами анализа
    """
    if model is None:
        return {
            "success": False,
            "error": "YOLO модель не загружена",
            "lotNumber": lot_number
        }

    try:
        # Преобразуем image_data в PIL Image
        if isinstance(image_data, str):
            # Base64 кодированное изображение
            image_data = base64.b64decode(image_data)

        img = Image.open(BytesIO(image_data)).convert("RGB")
        img_w, img_h = img.size

        results = model(img, conf=CONF_THRESHOLD)

        detections = []
        damage_summary = {}

        for result in results:
            masks = getattr(result, "masks", None)

            for i, box in enumerate(result.boxes):
                cls_id = int(box.cls[0])
                confidence = float(box.conf[0])
                damage_type = result.names.get(cls_id, f"class_{cls_id}").lower()

                x, y, w, h = (float(v) for v in box.xywh[0])

                # Модель сегментационная, поэтому площадь считается по маске:
                # у косой царапины описанная рамка почти вся пустая и завышает размер.
                if masks is not None and i < len(masks.data):
                    mask = masks.data[i]
                    mask_h, mask_w = mask.shape
                    area_share = float(mask.sum()) / float(mask_w * mask_h)
                else:
                    area_share = (w * h) / float(img_w * img_h)

                detections.append({
                    "type": damage_type,
                    "label": DAMAGE_CLASSES.get(damage_type, damage_type),
                    "confidence": round(confidence, 2),
                    "areaShare": round(area_share, 4),
                    "coordinates": {
                        "x": round(x),
                        "y": round(y),
                        "width": round(w),
                        "height": round(h),
                    },
                })

                damage_summary[damage_type] = damage_summary.get(damage_type, 0) + 1

        # Вердикт намеренно не выносится: severity и рекомендацию определяет
        # агент ASSESSOR, у которого есть цена, пробег и год выпуска.
        return {
            "success": True,
            "lotNumber": lot_number,
            "imageSize": {"width": img_w, "height": img_h},
            "detections": detections,
            "damageSummary": damage_summary,
            "totalDamages": len(detections),
            "maxConfidence": round(max((d["confidence"] for d in detections), default=0.0), 2),
            "largestDamageShare": round(max((d["areaShare"] for d in detections), default=0.0), 4),
            "photosAnalyzed": 1,
        }

    except Exception as e:
        logger.error(f"❌ Ошибка обработки фото для лота {lot_number}: {e}")
        return {
            "success": False,
            "error": str(e),
            "lotNumber": lot_number
        }

@app.route('/api/photos/assess', methods=['POST'])
def assess_endpoint():
    """
    API endpoint для оценки фото

    Ожидает:
    - photos: список base64 фото
    - lotNumber: номер лота (опционально)
    """
    try:
        data = request.get_json() or {}
        photos = data.get('photos', [])
        lot_number = data.get('lotNumber', 'unknown')

        if not photos:
            return jsonify({
                "success": False,
                "error": "Не передано фото",
                "lotNumber": lot_number
            }), 400

        image_bytes = []
        for photo_data in photos:
            image_bytes.append(
                base64.b64decode(photo_data) if isinstance(photo_data, str) else photo_data)

        results = [assess_photo(raw, lot_number) for raw in image_bytes]

        # Запускается всегда, а не только когда детектор что-то нашёл: машина
        # без крыши не попадает ни в один его класс и даёт пустой результат.
        vision_result = vision.analyze(image_bytes, lot_number)

        totals = {}
        for r in results:
            for damage_type, count in r.get('damageSummary', {}).items():
                totals[damage_type] = totals.get(damage_type, 0) + count

        combined = {
            "success": all(r.get('success', False) for r in results),
            "lotNumber": lot_number,
            "photosAnalyzed": len(photos),
            "assessments": results,
            "vision": vision_result,
            "summary": {
                "totalDamages": sum(r.get('totalDamages', 0) for r in results),
                "damageTypes": totals,
                "photosWithDamage": sum(1 for r in results if r.get('totalDamages')),
                "maxConfidence": round(max((r.get('maxConfidence', 0.0) for r in results), default=0.0), 2),
                "largestDamageShare": round(max((r.get('largestDamageShare', 0.0) for r in results), default=0.0), 4),
                # ASSESSOR должен знать границы модели: отсутствие класса в
                # detectableClasses означает «не проверялось», а не «дефекта нет».
                "detectableClasses": sorted(model.names.values()) if model else [],
                "detectorBlindSpots": [
                    "ржавчина и коррозия",
                    "отсутствующие детали и сорванные панели",
                    "состояние силовой структуры",
                    "срабатывание подушек безопасности",
                    "следы огня и затопления",
                ],
                "confidenceThreshold": CONF_THRESHOLD,
            }
        }

        return jsonify(combined), 200

    except Exception as e:
        logger.error(f"❌ Ошибка в endpoint: {e}")
        return jsonify({
            "success": False,
            "error": str(e)
        }), 500

@app.route('/health', methods=['GET'])
def health():
    """Проверка здоровья сервиса"""
    return jsonify({
        "status": "healthy",
        "yolo_loaded": model is not None,
        "model": MODEL_PATH,
        "classes": sorted(model.names.values()) if model else [],
        "visionBudget": vision.budget_status(),
        "service": "YOLO Photo Assessor v1.0"
    }), 200

@app.route('/', methods=['GET'])
def home():
    """Главная страница"""
    return jsonify({
        "name": "YOLO Photo Assessor Service",
        "version": "1.0.0",
        "endpoints": {
            "POST /api/photos/assess": "Анализирует фото автомобиля",
            "GET /health": "Проверка здоровья сервиса"
        }
    }), 200

if __name__ == '__main__':
    logger.info("🚀 Запускаем YOLO Photo Assessor Service на порте 3001...")
    app.run(host='0.0.0.0', port=3001, debug=False)
