# Worker Network Tx Chart + Per-Pod Drops Alert Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a per-pod Worker Network Tx (MB/s) chart alongside the existing CPU and Memory charts, and an amber alert banner that fires when any worker drops packets, showing which pods are affected.

**Architecture:** Two new JSON columns in `prometheus_samples` are populated by two new PromQL queries in the collector. The backend serializes them into the existing `/api/prometheus/runs/{id}` response. `chartDataUtils.promToChartData` flattens them into per-pod keys identical to the existing CPU/memory pattern. `RunCharts` consumes the keys for the chart and banner with no changes to `RunDetailPage`.

**Tech Stack:** Python/SQLAlchemy (backend), FastAPI, Recharts (frontend), Vitest, pytest-asyncio

---

## File Map

| File | Change |
|------|--------|
| `control-plane/models.py` | Add 2 columns to `PrometheusSample` |
| `control-plane/database.py` | Add 2 `ALTER TABLE` entries to `init_db()` |
| `control-plane/services/prometheus_collector.py` | Add 2 `_query_per_pod` calls in `_collect_sample` |
| `control-plane/routers/prometheus.py` | Add 2 fields to serialization dict |
| `control-plane/frontend/src/lib/chartDataUtils.js` | Parse 2 new JSON columns into per-pod chart keys |
| `control-plane/frontend/src/lib/__tests__/chartDataUtils.test.js` | Tests for new keys |
| `control-plane/tests/test_prometheus_collector.py` | Tests for new queries in `_collect_sample` |
| `control-plane/frontend/src/components/RunCharts.jsx` | Add drops banner + network Tx chart |

---

### Task 1: Add DB columns and migrate existing deployments

**Files:**
- Modify: `control-plane/models.py:104-106`
- Modify: `control-plane/database.py:42-53`

- [ ] **Step 1: Add columns to the ORM model**

In `control-plane/models.py`, add two lines after the `worker_cpu_per_pod` column (currently line 106):

```python
    worker_net_tx_per_pod  = Column(Text,  nullable=True)  # JSON: {"omb-worker-0": bytes_per_sec, ...}
    worker_net_drop_per_pod = Column(Text, nullable=True)  # JSON: {"omb-worker-0": drops_per_sec, ...}
```

- [ ] **Step 2: Register columns for existing deployments**

In `control-plane/database.py`, add two entries to the tuple in `init_db()` after the `worker_cpu_per_pod` line (currently line 48):

```python
            "ALTER TABLE prometheus_samples ADD COLUMN worker_net_tx_per_pod TEXT",
            "ALTER TABLE prometheus_samples ADD COLUMN worker_net_drop_per_pod TEXT",
```

The `try/except pass` wrapping each statement already handles the case where the column exists.

- [ ] **Step 3: Commit**

```bash
git add control-plane/models.py control-plane/database.py
git commit -m "feat: add worker_net_tx_per_pod and worker_net_drop_per_pod columns"
```

---

### Task 2: Collect network metrics in prometheus_collector

**Files:**
- Modify: `control-plane/services/prometheus_collector.py:67-116`
- Modify: `control-plane/tests/test_prometheus_collector.py`

- [ ] **Step 1: Write failing tests**

Append to `control-plane/tests/test_prometheus_collector.py`:

```python
@pytest.mark.asyncio
async def test_collect_sample_stores_net_tx_per_pod(monkeypatch):
    """_collect_sample writes worker_net_tx_per_pod JSON to the DB row."""
    from services import prometheus_collector

    captured = {}

    async def fake_query_per_pod(client, url, query):
        if "container_network_transmit_bytes_total" in query:
            return {"omb-worker-0": 52428800.0, "omb-worker-1": 31457280.0}
        return {}

    async def fake_query(client, url, query):
        return None

    class FakeSession:
        def __init__(self): self.added = []
        def add(self, obj): self.added.append(obj); captured['sample'] = obj
        async def commit(self): pass
        async def rollback(self): pass
        async def __aenter__(self): return self
        async def __aexit__(self, *a): pass

    monkeypatch.setattr(prometheus_collector, "_query_per_pod", fake_query_per_pod)
    monkeypatch.setattr(prometheus_collector, "_query", fake_query)
    monkeypatch.setattr(prometheus_collector, "AsyncSessionLocal", FakeSession)

    import httpx
    async with httpx.AsyncClient() as client:
        await prometheus_collector._collect_sample(client, "http://prom", "omb", 1, 0, 4.0)

    sample = captured['sample']
    assert sample.worker_net_tx_per_pod is not None
    parsed = json.loads(sample.worker_net_tx_per_pod)
    assert parsed["omb-worker-0"] == pytest.approx(52428800.0)
    assert parsed["omb-worker-1"] == pytest.approx(31457280.0)


@pytest.mark.asyncio
async def test_collect_sample_stores_net_drop_per_pod(monkeypatch):
    """_collect_sample writes worker_net_drop_per_pod JSON to the DB row."""
    from services import prometheus_collector

    captured = {}

    async def fake_query_per_pod(client, url, query):
        if "container_network_transmit_packets_dropped_total" in query:
            return {"omb-worker-2": 3.2}
        return {}

    async def fake_query(client, url, query):
        return None

    class FakeSession:
        def __init__(self): self.added = []
        def add(self, obj): self.added.append(obj); captured['sample'] = obj
        async def commit(self): pass
        async def rollback(self): pass
        async def __aenter__(self): return self
        async def __aexit__(self, *a): pass

    monkeypatch.setattr(prometheus_collector, "_query_per_pod", fake_query_per_pod)
    monkeypatch.setattr(prometheus_collector, "_query", fake_query)
    monkeypatch.setattr(prometheus_collector, "AsyncSessionLocal", FakeSession)

    import httpx
    async with httpx.AsyncClient() as client:
        await prometheus_collector._collect_sample(client, "http://prom", "omb", 1, 0, 4.0)

    sample = captured['sample']
    assert sample.worker_net_drop_per_pod is not None
    parsed = json.loads(sample.worker_net_drop_per_pod)
    assert parsed["omb-worker-2"] == pytest.approx(3.2)


@pytest.mark.asyncio
async def test_collect_sample_net_columns_null_when_queries_return_empty(monkeypatch):
    """worker_net_* columns are None when per-pod queries return empty dicts."""
    from services import prometheus_collector

    captured = {}

    async def fake_query_per_pod(client, url, query):
        return {}

    async def fake_query(client, url, query):
        return None

    class FakeSession:
        def __init__(self): self.added = []
        def add(self, obj): self.added.append(obj); captured['sample'] = obj
        async def commit(self): pass
        async def rollback(self): pass
        async def __aenter__(self): return self
        async def __aexit__(self, *a): pass

    monkeypatch.setattr(prometheus_collector, "_query_per_pod", fake_query_per_pod)
    monkeypatch.setattr(prometheus_collector, "_query", fake_query)
    monkeypatch.setattr(prometheus_collector, "AsyncSessionLocal", FakeSession)

    import httpx
    async with httpx.AsyncClient() as client:
        await prometheus_collector._collect_sample(client, "http://prom", "omb", 1, 0, 4.0)

    sample = captured['sample']
    assert sample.worker_net_tx_per_pod is None
    assert sample.worker_net_drop_per_pod is None
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
cd /path/to/omb-k8s/control-plane
pip install pytest pytest-asyncio httpx -q
pytest tests/test_prometheus_collector.py::test_collect_sample_stores_net_tx_per_pod tests/test_prometheus_collector.py::test_collect_sample_stores_net_drop_per_pod tests/test_prometheus_collector.py::test_collect_sample_net_columns_null_when_queries_return_empty -v
```

Expected: 3 failures (AttributeError on `worker_net_tx_per_pod`)

- [ ] **Step 3: Add two `_query_per_pod` calls in `_collect_sample`**

In `control-plane/services/prometheus_collector.py`, after the `cpu_per_pod` query (currently ending around line 96) and before the `async with AsyncSessionLocal()` block, add:

```python
    # container_network_* metrics are pod-level (no container label) — use a
    # separate selector that omits container="worker" from worker_selector.
    net_selector = f'namespace="{namespace}",pod=~"omb-worker-.*"'

    net_tx_per_pod = await _query_per_pod(client, prom_url,
        f'sum by (pod) ('
        f'  rate(container_network_transmit_bytes_total{{{net_selector},interface!="lo"}}[2m])'
        f')')

    net_drop_per_pod = await _query_per_pod(client, prom_url,
        f'sum by (pod) ('
        f'  rate(container_network_transmit_packets_dropped_total{{{net_selector},interface!="lo"}}[2m])'
        f'  +'
        f'  rate(container_network_receive_packets_dropped_total{{{net_selector},interface!="lo"}}[2m])'
        f')')

- [ ] **Step 4: Store the results in the `PrometheusSample` constructor**

In the same function, inside the `PrometheusSample(...)` call, add two keyword arguments after `worker_cpu_per_pod`:

```python
            worker_net_tx_per_pod=json.dumps(net_tx_per_pod) if net_tx_per_pod else None,
            worker_net_drop_per_pod=json.dumps(net_drop_per_pod) if net_drop_per_pod else None,
```

- [ ] **Step 5: Run tests to verify they pass**

```bash
pytest tests/test_prometheus_collector.py -v
```

Expected: all pass

- [ ] **Step 6: Commit**

```bash
git add control-plane/services/prometheus_collector.py control-plane/tests/test_prometheus_collector.py
git commit -m "feat: collect per-pod network tx and drop metrics"
```

---

### Task 3: Expose new columns in the API response

**Files:**
- Modify: `control-plane/routers/prometheus.py:63-77`

No new tests needed — the serialization dict is a mechanical mapping; the shape is covered by the frontend chartDataUtils tests in Task 4.

- [ ] **Step 1: Add two fields to the serialization dict**

In `control-plane/routers/prometheus.py`, inside the list comprehension in `get_prometheus_samples`, add after `"worker_cpu_per_pod": s.worker_cpu_per_pod,`:

```python
            "worker_net_tx_per_pod":   s.worker_net_tx_per_pod,
            "worker_net_drop_per_pod": s.worker_net_drop_per_pod,
```

- [ ] **Step 2: Commit**

```bash
git add control-plane/routers/prometheus.py
git commit -m "feat: include worker_net_tx_per_pod and worker_net_drop_per_pod in prometheus API response"
```

---

### Task 4: Parse new fields in chartDataUtils

**Files:**
- Modify: `control-plane/frontend/src/lib/chartDataUtils.js:55-83`
- Modify: `control-plane/frontend/src/lib/__tests__/chartDataUtils.test.js`

- [ ] **Step 1: Write failing tests**

In `chartDataUtils.test.js`, extend the existing `promToChartData` sample fixture and add new test cases. Add `worker_net_tx_per_pod` and `worker_net_drop_per_pod` to the first sample object (the second remains `null` to test the null path):

Update the first sample in the `samples` array at line 80 to add:
```js
      worker_net_tx_per_pod: '{"omb-worker-0":52428800,"omb-worker-1":31457280}',
      worker_net_drop_per_pod: '{"omb-worker-2":3.2}',
```

Update the second sample to add:
```js
      worker_net_tx_per_pod: null,
      worker_net_drop_per_pod: null,
```

Then add these test cases inside the `describe('promToChartData', ...)` block:

```js
  test('flattens worker_net_tx_per_pod JSON into workerNetTx_<pod> keys (bytes/sec)', () => {
    const result = promToChartData(samples);
    expect(result[0]['workerNetTx_omb-worker-0']).toBeCloseTo(52428800);
    expect(result[0]['workerNetTx_omb-worker-1']).toBeCloseTo(31457280);
  });

  test('flattens worker_net_drop_per_pod JSON into workerNetDrop_<pod> keys', () => {
    const result = promToChartData(samples);
    expect(result[0]['workerNetDrop_omb-worker-2']).toBeCloseTo(3.2);
  });

  test('workerNetTx_ keys are absent when worker_net_tx_per_pod is null', () => {
    const result = promToChartData(samples);
    expect(result[1]['workerNetTx_omb-worker-0']).toBeUndefined();
  });

  test('workerNetDrop_ keys are absent when worker_net_drop_per_pod is null', () => {
    const result = promToChartData(samples);
    expect(result[1]['workerNetDrop_omb-worker-2']).toBeUndefined();
  });
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
cd control-plane/frontend
npm test -- chartDataUtils
```

Expected: 4 new failures (keys undefined)

- [ ] **Step 3: Implement the parsing in `promToChartData`**

In `control-plane/frontend/src/lib/chartDataUtils.js`, after the `workerCpu_` loop (currently ending around line 78), add:

```js
    const netTxPerPod = s.worker_net_tx_per_pod
      ? JSON.parse(s.worker_net_tx_per_pod)
      : {};
    const netDropPerPod = s.worker_net_drop_per_pod
      ? JSON.parse(s.worker_net_drop_per_pod)
      : {};

    for (const [pod, val] of Object.entries(netTxPerPod)) {
      point[`workerNetTx_${pod}`] = val;
    }
    for (const [pod, val] of Object.entries(netDropPerPod)) {
      point[`workerNetDrop_${pod}`] = val;
    }
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
npm test -- chartDataUtils
```

Expected: all pass

- [ ] **Step 5: Commit**

```bash
git add control-plane/frontend/src/lib/chartDataUtils.js \
        control-plane/frontend/src/lib/__tests__/chartDataUtils.test.js
git commit -m "feat: parse worker_net_tx_per_pod and worker_net_drop_per_pod in promToChartData"
```

---

### Task 5: Add drops alert banner and Network Tx chart to RunCharts

**Files:**
- Modify: `control-plane/frontend/src/components/RunCharts.jsx`

RunCharts has no unit tests — it's a pure rendering component. Verify visually after the change by running the dev server against a live or replay dataset.

- [ ] **Step 1: Add cyan color constant**

In `RunCharts.jsx`, add to the `C` object after `workerMem: '#818cf8'` (line 26):

```js
  workerNetTx:   '#22d3ee',  // cyan
```

- [ ] **Step 2: Add derived network values**

After the `maxCpuPct` block (currently ending around line 173), add:

```js
  const hasNetworkMetrics = promPoints.some(p =>
    Object.keys(p).some(k => k.startsWith('workerNetTx_'))
  );

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

- [ ] **Step 3: Add the drops alert banner**

After the throttle alert banner (currently ending around line 293), add:

```jsx
      {/* Network drops alert */}
      {anyDrops && (
        <div style={{
          background: 'rgba(245,158,11,0.12)',
          border: '1px solid rgba(245,158,11,0.35)',
          borderRadius: 6,
          padding: '10px 14px',
          marginBottom: 12,
          color: '#fbbf24',
          fontSize: 13,
          lineHeight: 1.5,
        }}>
          ⚠ Network packet drops detected — worker NIC may be saturated. Throughput results may reflect worker network capacity rather than broker capacity.
          <div style={{ marginTop: 4, fontSize: 12, color: '#fcd34d' }}>
            {Object.entries(workerDropPeaks)
              .filter(([, v]) => v > 0)
              .sort(([a], [b]) => a.localeCompare(b))
              .map(([pod, v]) => (
                <span key={pod} style={{ marginRight: 16 }}>
                  {pod.replace('omb-worker-', 'worker-')}: {v.toFixed(2)} drops/s
                </span>
              ))}
          </div>
        </div>
      )}
```

- [ ] **Step 4: Expand the worker charts row to 3 columns and add the Network Tx chart**

Find the worker charts row (currently `{(hasWorkerMetrics || isLive) && (` around line 437). Change the opening `div` className from `charts-row-2` to conditional:

```jsx
      {(hasWorkerMetrics || isLive) && (
        <div className={hasNetworkMetrics ? 'charts-row charts-row-3' : 'charts-row charts-row-2'}>
```

Then after the closing `</ChartCard>` of the Worker Memory chart (before the row's closing `</div>`), add:

```jsx
          {hasNetworkMetrics && (
            <ChartCard title="Worker Network Tx (MB/s)" badge="worker">
              <ResponsiveContainer width="100%" height={180}>
                <LineChart data={promPoints} syncId="run">
                  <CartesianGrid strokeDasharray="3 3" stroke={C.grid} />
                  <XAxis dataKey="t" stroke={C.axis} tick={{ fill: C.axis, fontSize: 10 }} ticks={xTicks} tickFormatter={promXFmt} />
                  <YAxis stroke={C.axis} tick={{ fill: C.axis, fontSize: 10 }} width={55} domain={[0, 'auto']} tickFormatter={v => fmtMBTick(v / 1_048_576)} />
                  <Tooltip
                    contentStyle={{ background: '#171c28', border: '1px solid #2a3045', color: '#e8edf8', fontSize: 11 }}
                    labelFormatter={v => fmtTimeLabel(promTimeBase, v)}
                    formatter={(v, name) => [v != null ? fmtMBTick(v / 1_048_576) : '—', name]}
                  />
                  <Legend wrapperStyle={{ fontSize: 11, color: C.axis }} />
                  {workerPods.map((pod, i) => (
                    <Line
                      key={`nettx-${pod}`}
                      type="monotone"
                      dataKey={`workerNetTx_${pod}`}
                      name={pod.replace('omb-worker-', 'worker-')}
                      stroke={WORKER_COLORS[i % WORKER_COLORS.length]}
                      dot={false}
                      strokeWidth={2}
                      connectNulls
                    />
                  ))}
                </LineChart>
              </ResponsiveContainer>
            </ChartCard>
          )}
```

Note: `workerPods` is already derived from `workerMem_` keys earlier in the component. Since network and memory data come from the same samples, any run that has `workerNetTx_*` keys will also have `workerMem_*` keys, so `workerPods` is the correct pod list to iterate.

- [ ] **Step 5: Verify in browser**

```bash
cd control-plane/frontend && npm run dev
```

Open `http://localhost:5173`, navigate to a completed run that has Prometheus data. Confirm:
- Worker charts row shows 3 charts: CPU | Memory | Network Tx
- On a run without Prometheus data (or old run), row shows 2 charts: CPU | Memory
- Drops banner is absent on runs with no drops; simulate nonzero drops by temporarily returning mock data if needed

- [ ] **Step 6: Commit**

```bash
git add control-plane/frontend/src/components/RunCharts.jsx
git commit -m "feat: add Worker Network Tx chart and per-pod drops alert banner"
```

---

## Self-Review Notes

- **Spec coverage:** All 6 spec sections covered: DB columns (Task 1), PromQL queries (Task 2), API serialization (Task 3), chartDataUtils keys (Task 4), banner (Task 5 step 3), chart (Task 5 step 4), backward compat (handled by `hasNetworkMetrics` guard and null JSON paths). ✓
- **PromQL `interface` label:** The `worker_selector` variable includes `container="worker"` which may not be present on `container_network_*` metrics (those are pod-level, not container-level). The query should use only `namespace` and `pod` labels: use a separate selector string `f'namespace="{namespace}",pod=~"omb-worker-.*"'` for the network queries rather than re-using `worker_selector`. This is corrected in Task 2 Step 3 — the network queries use their own inline selectors without `container="worker"`.
- **`fmtMBTick` tooltip:** The tooltip `formatter` passes raw bytes/sec to `fmtMBTick` which expects MB/s values. The `workerNetTx_*` keys store raw bytes/sec (not converted). Two options: (a) convert to MB/s in `promToChartData`, (b) convert in the chart's `formatter`. Consistent with the memory chart pattern (stores MiB, converts in the chart), store bytes/sec and convert in the chart. The Y-axis `tickFormatter={fmtMBTick}` receives bytes/sec — update to convert: `tickFormatter={v => fmtMBTick(v / 1_048_576)}`. The tooltip formatter should be: `formatter={(v, name) => [v != null ? fmtMBTick(v / 1_048_576) : '—', name]}`. **Fix applied in Task 5 Step 4 above — the `fmtMBTick` calls in the chart must divide by 1_048_576.**
