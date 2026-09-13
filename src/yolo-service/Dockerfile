FROM python:3.11-slim

WORKDIR /app

# Установим системные зависимости для YOLO (OpenCV, PyTorch)
RUN apt-get update && \
    apt-get install -y --no-install-recommends \
    build-essential \
    git \
    curl \
    libgl1 \
    libglib2.0-0 \
    libsm6 \
    libxext6 \
    libxrender1 \
    && rm -rf /var/lib/apt/lists/*

# Копируем requirements
COPY requirements.txt .

# Устанавливаем Python зависимости
RUN pip install --no-cache-dir -r requirements.txt

# Веса модели, дообученной на повреждениях кузова (crack/dent/glass shatter/lamp broken/scratch/tire flat)
RUN curl -fsSL -o /app/car-damage.pt \
    https://huggingface.co/harpreetsahota/car-dd-segmentation-yolov11/resolve/main/best.pt

# Копируем приложение
COPY app.py .

# Предварительно загружаем YOLO модель (optional, экономит время при первом запуске)
# RUN python -c "from ultralytics import YOLO; YOLO('yolov8n.pt')"

# Expose порт
EXPOSE 3001

# Health check
HEALTHCHECK --interval=30s --timeout=10s --start-period=40s --retries=3 \
    CMD python -c "import requests; requests.get('http://localhost:3001/health')"

# Запускаем приложение
CMD ["python", "app.py"]
