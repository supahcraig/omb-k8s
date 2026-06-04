# Worker Network Tx Chart + Drops Alert

**Date:** 2026-06-04
**Scope:** Add a per-pod Worker Network Tx (MB/s) chart alongside the existing CPU and Memory worker charts, plus an amber alert banner when packet drops are detected.

---

## Problem

SEs have no visibility into whether benchmark workers are network-bound. Low throughput could be caused by the worker NIC saturating rather than the broker — currently indistinguishable. When using smaller instance types than the recommended m5.4xlarge, the NIC can become the bottleneck before CPU or memory.

---

## Data Flow

```
cAdvisor (kube-prometheus-stack)
  └─ prometheus_collector.py  ← 2 new queries per 15 s sample
       └─ prometheus_samples  ← 2 new columns
            └─ GET /api/prometheus/runs/{id}  ← 2 new fields
                 └─ chartDataUtils.js  ← new workerNetTx_<pod> keys
                      └─ RunCharts.jsx  ← new chart + new banner
```

No changes to `k8s_resources.py`, `schemas.py`, workers router, or `RunDetailPage.jsx`.

---

## Prometheus Queries

Both use cAdvisor `container_network_*` metrics, which are labeled by pod name. With `hostNetwork: true` on worker pods, cAdvisor attributes host-level network stats to the pod — this is the expected behavior on EKS with the AWS VPC CNI.

**Per-pod transmit rate** (via `_query_per_pod`):
```promql
sum by (pod) (
  rate(container_network_transmit_bytes_total{
    namespace="{ns}", pod=~"omb-worker-.*", interface!="lo"
  }[2m])
)
```
Returns `{pod_name: bytes_per_sec}`. Stored as JSON in `worker_net_tx_per_pod`.

**Per-pod drop rate** (via `_query_per_pod`):
```promql
sum by (pod) (
  rate(container_network_transmit_packets_dropped_total{
    namespace="{ns}", pod=~"omb-worker-.*", interface!="lo"
  }[2m])
  +
  rate(container_network_receive_packets_dropped_total{
    namespace="{ns}", pod=~"omb-worker-.*", interface!="lo"
  }[2m])
)
```
Returns `{pod_name: drops_per_sec}`. Stored as JSON in `worker_net_drop_per_pod`.

Both queries follow the same silent-no-op pattern as existing queries: `None` on any error or empty result.

---

## Backend Changes

### `models.py`
Add two columns to `PrometheusSample`:
- `worker_net_tx_per_pod` — `Column(Text, nullable=True)` — JSON `{"omb-worker-0": bytes_per_sec, ...}`
- `worker_net_drop_per_pod` — `Column(Text, nullable=True)` — JSON `{"omb-worker-0": drops_per_sec, ...}`

### `database.py`
Add two entries to the idempotent `ALTER TABLE` loop in `init_db()`:
```python
"ALTER TABLE prometheus_samples ADD COLUMN worker_net_tx_per_pod TEXT",
"ALTER TABLE prometheus_samples ADD COLUMN worker_net_drop_per_pod TEXT",
```

### `prometheus_collector.py`
In `_collect_sample`, add after the existing per-pod CPU query:
1. `net_tx_per_pod = await _query_per_pod(client, prom_url, <tx query>)`
2. `net_drop_per_pod = await _query_per_pod(client, prom_url, <drops query>)`

Pass to `PrometheusSample(...)`:
- `worker_net_tx_per_pod=json.dumps(net_tx_per_pod) if net_tx_per_pod else None`
- `worker_net_drop_per_pod=json.dumps(net_drop_per_pod) if net_drop_per_pod else None`

### `routers/prometheus.py`
Add to the serialization dict in `get_prometheus_samples`:
```python
"worker_net_tx_per_pod":  s.worker_net_tx_per_pod,
"worker_net_drop_per_pod": s.worker_net_drop_per_pod,
```

---

## Frontend Changes

### `chartDataUtils.js` — `promToChartData`
Parse both new JSON columns using the same loop pattern as `workerMem_` / `workerCpu_`:
- `worker_net_tx_per_pod` → `workerNetTx_<pod>` keys (bytes/sec)
- `worker_net_drop_per_pod` → `workerNetDrop_<pod>` keys (drops/sec)

### `RunCharts.jsx`

**New color constant:**
```js
workerNetTx: '#22d3ee',  // cyan
```

**New derived values** (alongside existing `maxCpuPct`, `maxThrottle`):
```js
const hasNetworkMetrics = promPoints.some(p =>
  Object.keys(p).some(k => k.startsWith('workerNetTx_'))
);
// Per-pod max drop rate across all samples: {pod: maxDropsPerSec}
const workerDropPeaks = {};
for (const p of promPoints) {
  for (const [k, v] of Object.entries(p)) {
    if (!k.startsWith('workerNetDrop_')) continue;
    const pod = k.slice('workerNetDrop_'.length);
    if ((v ?? 0) > (workerDropPeaks[pod] ?? 0)) workerDropPeaks[pod] = v;
  }
}
const anyDrops = Object.values(workerDropPeaks).some(v => v > 0);
```

**New alert banner** (placed after the throttle banner, before the chart rows):
Fires when `anyDrops`. Same amber styling as existing banners. Lists each pod with nonzero peak drops:
> ⚠ Network packet drops detected — worker NIC may be saturated. Throughput results may be limited by worker network capacity rather than broker capacity.
> &nbsp;&nbsp;omb-worker-2: 3.2 drops/s &nbsp; omb-worker-0: 0.5 drops/s

Render the pod list inline, filtering to pods where `workerDropPeaks[pod] > 0`, sorted by pod name.

**Row 4 layout change:**
Use `charts-row-3` when `hasNetworkMetrics`, `charts-row-2` otherwise. This keeps the existing 2-chart layout for old runs with no network data rather than leaving an empty third grid cell.

**New "Worker Network Tx (MB/s)" chart:**
- `badge="worker"`, `syncId="run"`, height 180
- Y-axis tick formatter: same `fmtMBTick` used by the OMB throughput chart
- One `<Line>` per pod using `workerNetTx_<pod>` keys and `WORKER_COLORS` (same pattern as CPU and Memory per-pod lines)
- Falls back to nothing (chart not rendered) if no network samples present

### `RunDetailPage.jsx`
No changes required. `promSamples` already flows through as a prop.

---

## Drop Lines in Chart

Per-pod drop series are **not** rendered in the Network Tx chart. Drop rates are flat-zero during healthy runs; overlaying them on the MB/s axis would require a secondary y-axis and clutter the chart for no benefit. The per-pod alert banner is the right surface for drop visibility.

---

## Alert Threshold

Drop rate > 0 triggers the banner. Drops are never normal — a single dropped packet on a benchmark NIC indicates queue overflow. There is no threshold to tune.

---

## Backward Compatibility

Old runs in SQLite have no `worker_net_tx_per_pod` or `worker_net_drop_per_pod` values. The API serializes `None`, `chartDataUtils` produces no `workerNetTx_*` or `workerNetDrop_*` keys, `hasNetworkMetrics` is false, `anyDrops` is false, and the third chart slot is not rendered. The existing 2-chart worker row is visually unchanged for old runs.

---

## Out of Scope

- NIC ceiling reference line (deferred — requires instance-type lookup)
- Receive traffic chart (transmit is the bottleneck side for a producer workload)
- Per-pod drop breakdown (aggregate is sufficient for the alert decision)
