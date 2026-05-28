# control-plane

FastAPI backend + React frontend for the OMB on Kubernetes platform.

## What it does

- Serves the React SPA at `/`
- Stores driver configs, workload configs, and benchmark results in SQLite
- Creates and monitors k8s Jobs that run the OMB benchmark binary
- Streams Job logs to the browser via WebSocket
- Polls Prometheus for per-pod worker metrics during runs
- Manages the omb-worker StatefulSet replica count for scaling

## Stack

- **Backend:** Python 3.11, FastAPI, SQLAlchemy (async), aiosqlite
- **Frontend:** React 18, Vite, Recharts
- **k8s client:** `kubernetes` Python SDK (in-cluster ServiceAccount)
- **Database:** SQLite at `/data/omb_ui.db` on a PersistentVolume

## Running locally

The backend requires a running k8s cluster. For local development without k8s,
the backend will start but k8s API calls will fail.

```bash
# Backend
cd control-plane
python -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt
uvicorn main:app --reload --port 8000
```

```bash
# Frontend (separate terminal)
cd control-plane/frontend
npm install
npm run dev   # proxies /api and /ws to localhost:8000
```

Open http://localhost:5173 in your browser.

## Building the image

The Dockerfile uses a multi-stage build:
1. Stage 1: Build the React frontend (`npm ci && npm run build` → `build/`)
2. Stage 2: Pull OMB binary from the published worker image
3. Stage 3: Assemble the runtime image with FastAPI app + static SPA + OMB binary

```bash
docker build --platform linux/amd64 -t omb-control-plane control-plane/
```

## Environment variables

| Variable | Default | Description |
|----------|---------|-------------|
| `OMB_DB_PATH` | `/data/omb_ui.db` | SQLite database path |
| `OMB_NAMESPACE` | `default` | Kubernetes namespace for Jobs and ConfigMaps |
| `PORT` | `8000` | HTTP listen port |

## Key source files

| File | Purpose |
|------|---------|
| `main.py` | FastAPI app setup, startup seeding of bundled workloads |
| `models.py` | SQLAlchemy ORM models |
| `schemas.py` | Pydantic request/response schemas |
| `routers/runs.py` | Run creation, launch, cancel |
| `routers/sweeps.py` | Parameter sweep creation and execution |
| `routers/workloads.py` | Workload library CRUD |
| `routers/settings.py` | Cluster connectivity and Prometheus settings |
| `routers/cluster.py` | StatefulSet scaling, pod health, restart |
| `routers/ws.py` | WebSocket log streaming |
| `services/runner.py` | k8s Job creation, worker probe, ConfigMap lifecycle |
| `services/prometheus_collector.py` | Per-pod metric collection during runs |

## Tests

```bash
cd control-plane
pytest tests/
```
