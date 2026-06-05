from datetime import datetime
from enum import Enum
from typing import Any, Dict, List, Optional  # noqa: F401 — Any kept for SweepCreate.parameter_axes

from pydantic import BaseModel


# ---------------------------------------------------------------------------
# Enums
# ---------------------------------------------------------------------------


class RunStatus(str, Enum):
    pending = "pending"
    running = "running"
    completed = "completed"
    failed = "failed"
    cancelled = "cancelled"


# ---------------------------------------------------------------------------
# Metrics
# ---------------------------------------------------------------------------


class MetricsOut(BaseModel):
    id: int
    run_id: int

    publish_rate_avg: Optional[float] = None

    publish_latency_avg: Optional[float] = None
    publish_latency_p50: Optional[float] = None
    publish_latency_p75: Optional[float] = None
    publish_latency_p95: Optional[float] = None
    publish_latency_p99: Optional[float] = None
    publish_latency_p999: Optional[float] = None
    publish_latency_p9999: Optional[float] = None
    publish_latency_max: Optional[float] = None

    end_to_end_latency_avg: Optional[float] = None
    end_to_end_latency_p50: Optional[float] = None
    end_to_end_latency_p75: Optional[float] = None
    end_to_end_latency_p95: Optional[float] = None
    end_to_end_latency_p99: Optional[float] = None
    end_to_end_latency_p999: Optional[float] = None
    end_to_end_latency_p9999: Optional[float] = None
    end_to_end_latency_max: Optional[float] = None

    consume_rate_avg: Optional[float] = None
    backlog_avg: Optional[float] = None
    backlog_timeseries: Optional[str] = None    # JSON text
    throughput_timeseries: Optional[str] = None  # JSON text

    model_config = {"from_attributes": True}


# ---------------------------------------------------------------------------
# Runs
# ---------------------------------------------------------------------------


class RunListItem(BaseModel):
    id: int
    name: Optional[str] = None
    status: RunStatus
    started_at: Optional[datetime] = None
    completed_at: Optional[datetime] = None
    # Key summary metric fields for table display
    publish_rate_avg: Optional[float] = None
    publish_latency_avg: Optional[float] = None
    publish_latency_p99: Optional[float] = None
    end_to_end_latency_avg: Optional[float] = None
    end_to_end_latency_p99: Optional[float] = None
    consume_rate_avg: Optional[float] = None

    model_config = {"from_attributes": True}


class RunOut(BaseModel):
    id: int
    name: Optional[str] = None
    status: RunStatus
    started_at: Optional[datetime] = None
    completed_at: Optional[datetime] = None
    warmup_started_at: Optional[datetime] = None
    benchmark_started_at: Optional[datetime] = None
    driver_config: Optional[str] = None
    workload_config: Optional[str] = None
    sweep_id: Optional[int] = None
    sweep_params: Optional[str] = None
    error_message: Optional[str] = None
    metrics: Optional[MetricsOut] = None

    model_config = {"from_attributes": True}


# ---------------------------------------------------------------------------
# Sweeps
# ---------------------------------------------------------------------------


class SweepCreate(BaseModel):
    name: Optional[str] = None
    workload_parameter_axes: Dict[str, Any] = {}
    driver_parameter_axes: Dict[str, Any] = {}
    parameter_axes: Optional[Dict[str, Any]] = None  # deprecated: treated as workload_parameter_axes
    cooldown_seconds: int = 60
    workload_content: str
    driver_base_content: str

    @property
    def effective_workload_axes(self) -> Dict[str, Any]:
        """Return workload axes, falling back to deprecated parameter_axes."""
        if self.workload_parameter_axes:
            return self.workload_parameter_axes
        return self.parameter_axes or {}


class SweepOut(BaseModel):
    id: int
    name: Optional[str] = None
    status: str
    parameter_axes: Optional[str] = None   # JSON text from DB
    cooldown_seconds: int
    started_at: Optional[datetime] = None
    completed_at: Optional[datetime] = None

    model_config = {"from_attributes": True}


# ---------------------------------------------------------------------------
# Workloads
# ---------------------------------------------------------------------------


class WorkloadOut(BaseModel):
    id: str
    name: str
    description: Optional[str] = None
    content: str
    is_bundled: bool
    cloned_from_id: Optional[str] = None
    created_at: Optional[datetime] = None
    updated_at: Optional[datetime] = None
    last_used_at: Optional[datetime] = None
    last_used_run_id: Optional[str] = None

    model_config = {"from_attributes": True}


class WorkloadCreate(BaseModel):
    name: str
    description: Optional[str] = None
    content: str
    cloned_from_id: Optional[str] = None


class WorkloadUpdate(BaseModel):
    name: str
    description: Optional[str] = None
    content: str


# ---------------------------------------------------------------------------
# Settings — Cluster & Prometheus config
# ---------------------------------------------------------------------------


class ClusterConfig(BaseModel):
    mode: str  # "byoc" | "self-hosted"
    bootstrap_servers: str
    tls_enabled: bool = False
    sasl_enabled: bool = False
    sasl_mechanism: Optional[str] = None   # SCRAM-SHA-256 | SCRAM-SHA-512 | PLAIN
    sasl_username: Optional[str] = None
    sasl_password: Optional[str] = None    # never returned in GET responses


class PrometheusConfig(BaseModel):
    mode: str  # "byoc" | "self-hosted"
    scrape_yaml: Optional[str] = None           # BYOC: full scrape job YAML (password stored as __REDACTED__)
    scrape_yaml_password: Optional[str] = None  # BYOC: encrypted password extracted from scrape_yaml
    scrape_targets: Optional[List[str]] = None  # self-hosted, comma-separated


class SettingsOut(BaseModel):
    cluster: Optional[ClusterConfig] = None
    prometheus: Optional[PrometheusConfig] = None


# ---------------------------------------------------------------------------
# Workers
# ---------------------------------------------------------------------------


class WorkerPod(BaseModel):
    name: str
    status: str


class WorkerStatus(BaseModel):
    desired: int
    ready: int
    pods: List[WorkerPod]


class WorkerResources(BaseModel):
    cpu_request_cores: float
    memory_limit_mib: int
