# ─── Stage 1: Build React frontend ────────────────────────────────────────────
FROM node:20-slim AS frontend-builder
WORKDIR /frontend
COPY frontend/package*.json ./
RUN npm ci --prefer-offline
COPY frontend/ ./
RUN npm run build

# ─── Stage 2: Runtime ─────────────────────────────────────────────────────────
FROM python:3.11-slim AS runtime
WORKDIR /app

# Python dependencies installed before copying app source for layer caching.
COPY requirements.txt ./
RUN pip install --no-cache-dir -r requirements.txt

# Application source
COPY config.py database.py main.py models.py schemas.py ./
COPY routers/ ./routers/
COPY services/ ./services/

# React SPA served by FastAPI at /app/static/
COPY --from=frontend-builder /frontend/build ./static

# Bundled workload YAMLs — seeded into SQLite on first startup
COPY workloads/ /app/workloads/

ENV OMB_DB_PATH=/data/omb_ui.db \
    OMB_NAMESPACE=default \
    PORT=8000

EXPOSE 8000

CMD ["sh", "-c", "exec uvicorn main:app --host 0.0.0.0 --port ${PORT:-8000}"]
