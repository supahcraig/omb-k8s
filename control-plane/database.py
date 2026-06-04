from sqlalchemy import event
from sqlalchemy.ext.asyncio import create_async_engine, AsyncSession, async_sessionmaker
from sqlalchemy.orm import DeclarativeBase

from config import settings


class Base(DeclarativeBase):
    pass


engine = create_async_engine(
    f"sqlite+aiosqlite:///{settings.omb_db_path}",
    echo=False,
    connect_args={"check_same_thread": False},
)


@event.listens_for(engine.sync_engine, "connect")
def _set_sqlite_pragma(dbapi_conn, _record):
    cursor = dbapi_conn.cursor()
    cursor.execute("PRAGMA foreign_keys=ON")
    cursor.close()


AsyncSessionLocal = async_sessionmaker(
    bind=engine,
    class_=AsyncSession,
    expire_on_commit=False,
    autoflush=False,
    autocommit=False,
)


async def init_db() -> None:
    import models  # noqa: F401 — registers ORM classes with Base.metadata
    from sqlalchemy import text
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)
        # Add worker metric columns to existing deployments where the table
        # already exists — SQLAlchemy create_all won't add new columns.
        for col_ddl in (
            "ALTER TABLE prometheus_samples ADD COLUMN worker_cpu_pct REAL",
            "ALTER TABLE prometheus_samples ADD COLUMN worker_memory_mib REAL",
            "ALTER TABLE prometheus_samples ADD COLUMN worker_throttle_pct REAL",
            "ALTER TABLE runs ADD COLUMN error_message TEXT",
            "ALTER TABLE prometheus_samples ADD COLUMN worker_memory_per_pod TEXT",
            "ALTER TABLE prometheus_samples ADD COLUMN worker_cpu_per_pod TEXT",
            "ALTER TABLE prometheus_samples ADD COLUMN worker_net_tx_per_pod TEXT",
            "ALTER TABLE prometheus_samples ADD COLUMN worker_net_drop_per_pod TEXT",
        ):
            try:
                await conn.execute(text(col_ddl))
            except Exception:
                pass  # column already exists


async def get_db():
    async with AsyncSessionLocal() as session:
        yield session
