FROM python:3.12-slim

ENV PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1 \
    DIREK_HOST=0.0.0.0 \
    DIREK_PORT=8000 \
    DIREK_BACKEND=openai \
    DIREK_API_BASE=http://model:8001/v1

WORKDIR /app

COPY requirements.txt ./
RUN pip install -r requirements.txt

COPY direk ./direk
COPY static ./static
COPY data ./data

EXPOSE 8000

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s \
    CMD python -c "import urllib.request;urllib.request.urlopen('http://127.0.0.1:8000/health')" || exit 1

CMD ["python", "-m", "direk"]
