# Base image leggera e stabile Python 3.9
FROM python:3.9-slim

# Il set di pacchetti di sistema necessari (curl, build essentials, etc)
RUN apt-get update && apt-get install -y --no-install-recommends \
    build-essential \
    curl \
    ca-certificates \
    gcc \
    libffi-dev \
    libssl-dev \
    python3-dev \
    && rm -rf /var/lib/apt/lists/*

# Crea la cartella di lavoro
WORKDIR /app

# Copia requirements
COPY requirements.txt .

# Installa le dipendenze Python
RUN pip install --no-cache-dir -r requirements.txt

# Copia il codice dell'applicazione
COPY . .

# Monta il socket Docker
VOLUME ["/var/run/docker.sock"]

# Espone vari porta se necessarie (non obbligatorio)
EXPOSE 8080

# Comando di default all'avvio del container
CMD ["python", "app.py"]
