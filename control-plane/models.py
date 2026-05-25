from datetime import datetime
from uuid import uuid4

from sqlalchemy import (
    Boolean,
    Column,
    DateTime,
    Float,
    ForeignKey,
    Integer,
    String,
    Text,
)
from sqlalchemy.orm import relationship

from database import Base


class Run(Base):
    __tablename__ = "runs"

    id = Column(Integer, primary_key=True, autoincrement=True)
    name = Column(String, nullable=True)
    status = Column(String, nullable=False, default="pending")
    # "pending" | "running" | "completed" | "failed" | "cancelled"
    started_at = Column(DateTime, default=datetime.utcnow)
    completed_at = Column(DateTime, nullable=True)
    # Full YAML snapshots stored as raw text (not JSON) for immutability
    driver_config = Column(Text, nullable=True)
    workload_config = Column(Text, nullable=True)
    sweep_id = Column(Integer, nullable=True)  # not FK-constrained intentionally
    sweep_params = Column(Text, nullable=True)  # stored as JSON text

    metrics = relationship(
        "Metrics",
        back_populates="run",
        uselist=False,
        cascade="all, delete-orphan",
    )
    prometheus_samples = relationship(
        "PrometheusSample",
        back_populates="run",
        cascade="all, delete-orphan",
        passive_deletes=True,
    )


class Metrics(Base):
    __tablename__ = "metrics"

    id = Column(Integer, primary_key=True, autoincrement=True)
    run_id = Column(
        Integer,
        ForeignKey("runs.id", ondelete="CASCADE"),
        unique=True,
        nullable=False,
    )

    publish_rate_avg = Column(Float, nullable=True)

    publish_latency_avg = Column(Float, nullable=True)
    publish_latency_p50 = Column(Float, nullable=True)
    publish_latency_p75 = Column(Float, nullable=True)
    publish_latency_p95 = Column(Float, nullable=True)
    publish_latency_p99 = Column(Float, nullable=True)
    publish_latency_p999 = Column(Float, nullable=True)
    publish_latency_p9999 = Column(Float, nullable=True)
    publish_latency_max = Column(Float, nullable=True)

    end_to_end_latency_avg = Column(Float, nullable=True)
    end_to_end_latency_p50 = Column(Float, nullable=True)
    end_to_end_latency_p75 = Column(Float, nullable=True)
    end_to_end_latency_p95 = Column(Float, nullable=True)
    end_to_end_latency_p99 = Column(Float, nullable=True)
    end_to_end_latency_p999 = Column(Float, nullable=True)
    end_to_end_latency_p9999 = Column(Float, nullable=True)
    end_to_end_latency_max = Column(Float, nullable=True)

    consume_rate_avg = Column(Float, nullable=True)
    backlog_avg = Column(Float, nullable=True)
    backlog_timeseries = Column(Text, nullable=True)       # JSON text
    throughput_timeseries = Column(Text, nullable=True)    # JSON text

    run = relationship("Run", back_populates="metrics")


class PrometheusSample(Base):
    __tablename__ = "prometheus_samples"

    id = Column(Integer, primary_key=True, autoincrement=True)
    run_id = Column(
        Integer,
        ForeignKey("runs.id", ondelete="CASCADE"),
        nullable=False,
        index=True,
    )
    t = Column(Integer, nullable=False)  # elapsed seconds
    bytes_in_per_sec = Column(Float, nullable=True)
    bytes_out_per_sec = Column(Float, nullable=True)
    records_per_sec = Column(Float, nullable=True)

    run = relationship("Run", back_populates="prometheus_samples")


class Sweep(Base):
    __tablename__ = "sweeps"

    id = Column(Integer, primary_key=True, autoincrement=True)
    name = Column(String, nullable=False)
    status = Column(String, nullable=False, default="running")
    # "running" | "completed" | "cancelled"
    parameter_axes = Column(Text, nullable=True)   # JSON text
    cooldown_seconds = Column(Integer, nullable=False, default=60)
    started_at = Column(DateTime, default=datetime.utcnow)
    completed_at = Column(DateTime, nullable=True)


class Workload(Base):
    __tablename__ = "workloads"

    id = Column(String, primary_key=True, default=lambda: str(uuid4()))
    name = Column(String, nullable=False)
    description = Column(String, nullable=True)
    content = Column(Text, nullable=False)        # full YAML content
    is_bundled = Column(Boolean, default=False)
    cloned_from_id = Column(String, nullable=True)  # no FK — source may be deleted
    created_at = Column(DateTime, default=datetime.utcnow)
    updated_at = Column(DateTime, default=datetime.utcnow, onupdate=datetime.utcnow)
    last_used_at = Column(DateTime, nullable=True)
    # Intentionally no FK constraint — runs.id is INTEGER but kept as String
    # to avoid cross-type FK complications and for flexibility.
    last_used_run_id = Column(String, nullable=True)


class Setting(Base):
    __tablename__ = "settings"

    key = Column(String, primary_key=True)
    value = Column(Text, nullable=False)
