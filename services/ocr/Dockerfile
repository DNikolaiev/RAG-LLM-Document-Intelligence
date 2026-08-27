FROM python:3.13.7-slim

ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1
RUN apt-get update \
  && apt-get install -y --no-install-recommends tesseract-ocr tesseract-ocr-deu tesseract-ocr-eng \
  && rm -rf /var/lib/apt/lists/* \
  && useradd --create-home --uid 10001 caselens
WORKDIR /app
COPY services/ocr/requirements.txt ./requirements.txt
RUN pip install --no-cache-dir -r requirements.txt
COPY services/ocr/app.py ./app.py
USER caselens
EXPOSE 8000
HEALTHCHECK --interval=10s --timeout=3s --retries=12 CMD ["python", "-c", "import urllib.request; urllib.request.urlopen('http://127.0.0.1:8000/health')"]
CMD ["uvicorn", "app:app", "--host", "0.0.0.0", "--port", "8000"]
