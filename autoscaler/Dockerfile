FROM python:3.12-alpine
WORKDIR /app
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt
COPY main.py utils.py .
COPY healthcheck.py /app/healthcheck.py
ENV ADMIN_API_PORT=9090
ENV PYTHONUNBUFFERED=1
HEALTHCHECK --interval=30s --timeout=10s --start-period=30s --retries=3 \
  CMD python /app/healthcheck.py
CMD ["python", "main.py"]
