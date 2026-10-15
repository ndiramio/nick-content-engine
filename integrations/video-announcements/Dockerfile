FROM python:3.12-slim
WORKDIR /app
COPY worker.py /app/worker.py
ENV PYTHONUNBUFFERED=1
CMD ["python", "/app/worker.py"]
