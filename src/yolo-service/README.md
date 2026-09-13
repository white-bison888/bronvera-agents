# YOLO Photo Assessment Service

Локальный сервис для поиска повреждений кузова на фотографиях автомобиля.
Заменяет платный Vision API на бесплатную модель, работающую на своём сервере.

## Что модель умеет и чего не умеет

Используется `car-damage.pt` — YOLO11, дообученная на датасете CarDD.
Веса скачиваются на этапе сборки образа, в git не хранятся.

**Распознаёт шесть типов дефектов:**

| Класс модели | Русское название |
|---|---|
| `dent` | вмятина |
| `scratch` | царапина |
| `crack` | трещина |
| `glass shatter` | разбитое стекло |
| `lamp broken` | разбитая фара |
| `tire flat` | спущенное колесо |

**Не распознаёт ржавчину и коррозию** — такого класса в модели нет.
Пустой результат означает «эти шесть типов не найдены», а не «машина целая».
Поэтому в ответе всегда возвращается `detectableClasses` — список того,
что вообще проверялось.

## Сервис не выносит вердиктов

Endpoint возвращает только наблюдения: что найдено, где, с какой уверенностью.
Оценку тяжести и рекомендацию по ставке принимает агент **ASSESSOR** в Dify —
у него есть цена, пробег, год выпуска и рыночный контекст, которых у модели нет.

Раньше сервис считал severity сам по количеству находок. Это убрано: подсчёт
без учёта типа дефекта приравнивал три царапины к разбитому стеклу.

## API

### POST `/api/photos/assess`

**Запрос:**
```json
{
  "photos": ["base64_изображение_1", "base64_изображение_2"],
  "lotNumber": "12345678"
}
```

**Ответ:**
```json
{
  "success": true,
  "lotNumber": "12345678",
  "photosAnalyzed": 1,
  "assessments": [
    {
      "success": true,
      "lotNumber": "12345678",
      "detections": [
        {
          "type": "lamp broken",
          "label": "разбитая фара",
          "confidence": 0.96,
          "coordinates": { "x": 150, "y": 200, "width": 50, "height": 40 }
        }
      ],
      "damageSummary": { "lamp broken": 1 },
      "totalDamages": 1,
      "photosAnalyzed": 1
    }
  ],
  "summary": {
    "totalDamages": 1,
    "damageTypes": { "lamp broken": 1 },
    "detectableClasses": ["crack", "dent", "glass shatter", "lamp broken", "scratch", "tire flat"],
    "confidenceThreshold": 0.35
  }
}
```

### GET `/health`

```json
{
  "status": "healthy",
  "yolo_loaded": true,
  "model": "/app/car-damage.pt",
  "classes": ["crack", "dent", "glass shatter", "lamp broken", "scratch", "tire flat"],
  "service": "YOLO Photo Assessor v1.0"
}
```

Список классов отдаётся намеренно: однажды сервис работал со стоковой моделью,
которая повреждений не знала вовсе, а `/health` при этом показывал «healthy».
Теперь подменённую модель видно сразу.

## Развёртывание на Hetzner

Внутри контейнера сервис слушает 3001, наружу проброшен **3002**
(3001 на хосте занят другим процессом).

```bash
scp -r src/yolo-service root@2.28.54.56:/opt/bronvera-agents/src/

ssh root@2.28.54.56
cd /opt/bronvera-agents/src/yolo-service
docker build -t yolo-assessor:latest .
docker run -d --name yolo-assessor -p 3002:3001 --memory=3g yolo-assessor:latest

curl http://localhost:3002/health
```

Dify обращается к сервису по адресу `http://host.docker.internal:3002/api/photos/assess`.

## Настройки

| Переменная | По умолчанию | Смысл |
|---|---|---|
| `MODEL_PATH` | `/app/car-damage.pt` | путь к весам |
| `CONF_THRESHOLD` | `0.35` | нижняя граница уверенности |

Порог 0.35 подобран на реальных снимках: вмятины от града набирают 0.46 и при
0.5 терялись, а на 0.1 начинают появляться ложные срабатывания с 0.17–0.21.
Значение стоит перепроверить на своей выборке аукционных фото.

## Зависимости образа

`python:3.11-slim` не содержит системных библиотек, с которыми слинкован OpenCV.
Без `libgl1` и `libglib2.0-0` контейнер падает при старте на `ImportError`,
а Dify получает HTTP 503 — это уже случалось.

Torch ставится из CPU-индекса PyTorch: на CPX22 нет видеокарты, а CUDA-сборка
раздувала образ до 9.5 ГБ. Сейчас 3.3 ГБ.

## Лицензия

`ultralytics` и веса CarDD распространяются под **AGPL-3.0**. Для коммерческого
сетевого сервиса это требует раскрытия исходного кода либо покупки коммерческой
лицензии у Ultralytics. Вопрос нужно закрыть до вывода проекта в продажу.

## Диагностика

```bash
docker logs -f yolo-assessor
curl http://localhost:3002/health
```
