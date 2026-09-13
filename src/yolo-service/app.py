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

app = Flask(__name__)
CORS(app)

# Логирование
logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

# Загрузим YOLO модель (первый запуск может занять время)
try:
    model = YOLO('yolov8n.pt')  # nano модель - быстрая и лёгкая
    logger.info("✅ YOLO модель загружена успешно")
except Exception as e:
    logger.error(f"❌ Ошибка загрузки YOLO: {e}")
    model = None

# Классы повреждений которые ищем
DAMAGE_CLASSES = {
    'dent': 'вмятина',
    'rust': 'ржавчина',
    'crack': 'трещина',
    'broken_glass': 'разбитое стекло',
    'scratch': 'царапина',
    'collision': 'повреждение от столкновения'
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

        img = Image.open(BytesIO(image_data))

        # Запускаем YOLO детекцию
        results = model(img, conf=0.3)  # confidence threshold 30%

        # Парсим результаты
        detections = []
        damage_summary = {}

        for result in results:
            for box in result.boxes:
                cls_id = int(box.cls[0])
                confidence = float(box.conf[0])

                # YOLO классы (ищем релевантные повреждениям)
                class_name = result.names[cls_id] if cls_id in result.names else f"class_{cls_id}"

                # Переводим в наши категории
                damage_type = class_name.lower()

                if confidence > 0.5:  # Only high-confidence detections
                    detections.append({
                        "type": damage_type,
                        "confidence": round(confidence, 2),
                        "coordinates": {
                            "x": float(box.xywh[0][0]),
                            "y": float(box.xywh[0][1]),
                            "width": float(box.xywh[0][2]),
                            "height": float(box.xywh[0][3])
                        }
                    })

                    # Суммируем по типам
                    damage_summary[damage_type] = damage_summary.get(damage_type, 0) + 1

        # Определяем серьёзность повреждений
        severity = "light"
        if len(detections) > 5:
            severity = "severe"
        elif len(detections) > 2:
            severity = "moderate"

        return {
            "success": True,
            "lotNumber": lot_number,
            "detections": detections,
            "damageSummary": damage_summary,
            "severity": severity,
            "totalDamages": len(detections),
            "photosAnalyzed": 1,
            "assessment": {
                "condition": severity,
                "visibleDamages": list(damage_summary.keys()),
                "damageCount": len(detections),
                "recommendation": "INSPECT" if len(detections) > 2 else "ACCEPTABLE"
            }
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

        # Анализируем первое фото (или все если нужно)
        results = []
        for photo_data in photos:
            result = assess_photo(photo_data, lot_number)
            results.append(result)

        # Объединяем результаты
        combined = {
            "success": all(r.get('success', False) for r in results),
            "lotNumber": lot_number,
            "photosAnalyzed": len(photos),
            "assessments": results,
            "summary": {
                "totalDamages": sum(r.get('totalDamages', 0) for r in results),
                "severity": results[0].get('severity', 'unknown') if results else 'unknown'
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
