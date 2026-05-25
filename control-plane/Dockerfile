# ─── Stage 1: Build React frontend ────────────────────────────────────────────
# Requires control-plane/frontend/ to exist (added in Session 5).
FROM node:20-slim AS frontend-builder
WORKDIR /frontend
COPY frontend/package*.json ./
RUN npm ci --prefer-offline
COPY frontend/ ./
RUN npm run build

# ─── Stage 2: OMB binary source ───────────────────────────────────────────────
# Pull the OMB benchmark binary and JARs from the published worker image so
# the control plane image can run driver jobs locally if needed.
FROM ghcr.io/supahcraig/omb-worker:latest AS omb-source

# ─── Stage 3: Runtime ─────────────────────────────────────────────────────────
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

# OMB benchmark binary and driver JARs
COPY --from=omb-source /omb/bin/benchmark /app/bin/benchmark
COPY --from=omb-source /omb/lib/ /app/lib/
RUN chmod +x /app/bin/benchmark

# Bundled workload YAMLs — seeded into SQLite on first startup
COPY workloads/ /app/workloads/

ENV OMB_DB_PATH=/data/omb_ui.db \
    OMB_NAMESPACE=default \
    PORT=8000

EXPOSE 8000

CMD ["sh", "-c", "exec uvicorn main:app --host 0.0.0.0 --port ${PORT:-8000}"]
