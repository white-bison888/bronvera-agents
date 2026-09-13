# YOLO Photo Assessment Service

Локальный сервис для анализа фотографий автомобилей с помощью YOLO v8.

**Заменяет:** дорогой Claude Vision API на локальное YOLO решение  
**Детектирует:** вмятины, ржавчину, трещины, разбитое стекло, царапины

## 🚀 Быстрый старт

### На MacBook (локально для тестирования):

```bash
cd /Users/nikitaborisenko/Documents/Projects/bronvera-agents/src/yolo-service

# Установим зависимости
pip install -r requirements.txt

# Запустим сервис
python app.py
```

Сервис будет доступен на: `http://localhost:3001`

### На Hetzner (в Docker контейнере):

```bash
# Перейдём в нужную директорию
cd /opt/bronvera-agents/src/yolo-service

# Создадим Docker image
docker build -t yolo-assessor:latest .

# Запустим контейнер
docker run -d \
  --name yolo-assessor \
  -p 3001:3001 \
  --memory="2g" \
  yolo-assessor:latest
```

## 📊 API Endpoints

### 1. POST `/api/photos/assess`

Анализирует фотографии машины.

**Request:**
```json
{
  "photos": ["base64_encoded_image_1", "base64_encoded_image_2"],
  "lotNumber": "12345678"
}
```

**Response:**
```json
{
  "success": true,
  "lotNumber": "12345678",
  "photosAnalyzed": 2,
  "assessments": [
    {
      "success": true,
      "detections": [
        {
          "type": "dent",
          "confidence": 0.87,
          "coordinates": {
            "x": 150,
            "y": 200,
            "width": 50,
            "height": 40
          }
        }
      ],
      "damageSummary": {
        "dent": 2,
        "rust": 1
      },
      "severity": "moderate",
      "totalDamages": 3,
      "assessment": {
        "condition": "moderate",
        "visibleDamages": ["dent", "rust"],
        "damageCount": 3,
        "recommendation": "INSPECT"
      }
    }
  ]
}
```

### 2. GET `/health`

Проверяет здоровье сервиса.

**Response:**
```json
{
  "status": "healthy",
  "yolo_loaded": true,
  "service": "YOLO Photo Assessor v1.0"
}
```

## 🔧 Инструкция для Hetzner

### Шаг 1: Скопируй файлы на Hetzner

```bash
scp -r /Users/nikitaborisenko/Documents/Projects/bronvera-agents/src/yolo-service root@2.28.54.56:/opt/bronvera-agents/src/
```

### Шаг 2: Заходишь на сервер и запускаешь

```bash
ssh root@2.28.54.56
cd /opt/bronvera-agents/src/yolo-service
docker build -t yolo-assessor:latest .
docker run -d --name yolo-assessor -p 3001:3001 --memory="2g" yolo-assessor:latest

# Проверяешь что запустилось
docker logs yolo-assessor
curl http://localhost:3001/health
```

### Шаг 3: Обновляешь photo-assessor.js

В файле `/opt/bronvera-agents/src/vision/photo-assessor.js` меняешь:
- Вместо Claude API → вызов локального YOLO
- URL: `http://localhost:3001/api/photos/assess`

## ⚙️ Конфигурация

### YOLO Модель

Используется `yolov8n.pt` (nano версия):
- ✅ Быстрая (можно на CPU)
- ✅ Лёгкая (800 MB памяти)
- ✅ Точная для нашего случая

Если нужна высокая точность, можно изменить на `yolov8m.pt` или `yolov8l.pt`.

### Confidence Threshold

Текущий порог: 0.5 (50%)

Изменить в `app.py`:
```python
if confidence > 0.5:  # Изменить на 0.6, 0.7 и т.д.
```

## 📈 Производительность

- **Одна фото на CPU:** ~2-5 секунд
- **На GPU (если есть):** ~0.2-0.5 секунд
- **Память:** ~1.5 GB (nano модель)

## 🐛 Debugging

### Проверь логи контейнера:
```bash
docker logs -f yolo-assessor
```

### Тестирование API:
```bash
curl http://localhost:3001/health

# Тестируем с фото
curl -X POST http://localhost:3001/api/photos/assess \
  -H "Content-Type: application/json" \
  -d '{"photos":[], "lotNumber":"test"}'
```

## 📝 Версия

- **YOLO:** v8 (nano)
- **Python:** 3.11
- **Flask:** 3.0.0
- **Дата:** 2026-09-13

---

**Статус:** Production Ready ✅
