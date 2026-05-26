import importlib
import logging
import os
from contextlib import asynccontextmanager

from fastapi import FastAPI
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles

from database import init_db
from services.seeder import seed_bundled_workloads

logger = logging.getLogger(__name__)

STATIC_DIR = os.path.join(os.path.dirname(__file__), "static")


@asynccontextmanager
async def lifespan(app: FastAPI):
    """Application lifespan: initialise DB and seed bundled workloads on startup."""
    logger.info("Starting up — initialising database …")
    await init_db()
    logger.info("Database initialised.")
    await seed_bundled_workloads()
    yield
    logger.info("Shutting down.")


app = FastAPI(
    title="OMB Control Plane",
    description="Orchestrates OpenMessaging Benchmark runs on Kubernetes.",
    version="0.1.0",
    lifespan=lifespan,
)

# ---------------------------------------------------------------------------
# API routers — imported conditionally so the app still starts even when
# individual router modules have not been created yet.
# ---------------------------------------------------------------------------

_routers_to_mount = [
    ("routers.runs", "/api/runs", ["runs"]),
    ("routers.sweeps", "/api/sweeps", ["sweeps"]),
    ("routers.workloads", "/api/workloads", ["workloads"]),
    ("routers.settings", "/api/settings", ["settings"]),
    ("routers.workers", "/api/workers", ["workers"]),
    ("routers.prometheus", "/api/prometheus", ["prometheus"]),
    ("routers.cluster",   "/api/cluster",    ["cluster"]),
]

for module_path, prefix, tags in _routers_to_mount:
    try:
        module = importlib.import_module(module_path)
        app.include_router(module.router, prefix=prefix, tags=tags)
        logger.info("Mounted router: %s at %s", module_path, prefix)
    except ModuleNotFoundError:
        logger.warning(
            "Router module %s not found — skipping (will be unavailable).",
            module_path,
        )

# WebSocket router — prefix /ws so the path resolves to /ws/runs/{run_id}
try:
    from routers.ws import router as ws_router

    app.include_router(ws_router, prefix="/ws", tags=["websocket"])
    logger.info("Mounted WebSocket router at /ws/runs/{run_id}")
except ModuleNotFoundError:
    logger.warning("WebSocket router (routers.ws) not found — skipping.")

# ---------------------------------------------------------------------------
# Health check
# ---------------------------------------------------------------------------


@app.get("/healthz", include_in_schema=False)
async def healthz():
    return JSONResponse({"status": "ok"})


# ---------------------------------------------------------------------------
# Static file serving for the React SPA
# ---------------------------------------------------------------------------

if os.path.isdir(STATIC_DIR):
    # Vite builds JS/CSS into assets/ — mount it at /assets so the browser
    # can fetch them with the correct MIME type.
    _assets_dir = os.path.join(STATIC_DIR, "assets")
    if os.path.isdir(_assets_dir):
        app.mount("/assets", StaticFiles(directory=_assets_dir), name="assets")

    @app.get("/{full_path:path}", include_in_schema=False)
    async def spa_fallback(full_path: str):
        """Serve index.html for any path not matched by an API route."""
        index = os.path.join(STATIC_DIR, "index.html")
        if os.path.isfile(index):
            return FileResponse(index)
        return JSONResponse({"detail": "Frontend not built."}, status_code=404)

else:
    logger.warning(
        "Static directory %s does not exist — frontend will not be served. "
        "This is expected in development before 'npm run build'.",
        STATIC_DIR,
    )

    @app.get("/", include_in_schema=False)
    async def root_dev():
        return JSONResponse(
            {
                "message": "OMB Control Plane API is running.",
                "note": "Frontend static files not found. Run 'npm run build' in frontend/.",
            }
        )


# ---------------------------------------------------------------------------
# Entry point for local development
# ---------------------------------------------------------------------------

if __name__ == "__main__":
    import uvicorn
    from config import settings

    logging.basicConfig(level=logging.INFO)
    uvicorn.run("main:app", host="0.0.0.0", port=settings.port, reload=True)
