# Concurrent Workloads Design

**Date:** 2026-06-12

## Context

The omb-k8s platform currently supports only one active benchmark run at a time. SEs need to simulate realistic mixed-production workloads by running multiple workloads simultaneously against the same cluster — and measure each workload's latency accurately under combined load. The key insight from design is: **temporal overlap already defines concurrency**. No new "group" entity is needed. The existing `started_at`/`completed_at` columns on `runs` are sufficient to detect and visualize concurrent relationships. A Gantt chart on a new `/timeline` page makes these relationships visible.

A single run is a trivial case of a concurrent run, in the same way a single run is a trivial case of a sweep. Every run owns a dedicated worker pool. The default `omb-worker` pool is used when no concurrent activity exists (full backward compatibility). A new pool is provisioned automatically when a run starts while another is in flight.

The "background workload + sweep" use case — one static workload running for the full sweep duration while another workload's parameters are swept — falls out of this design for free. No Phase 2 distinction needed. It's just a long-running run overlapping with a sweep, visualized naturally on the Gantt chart.

---

## Data Model

### New table: `worker_pools`

| Column | Type | Notes |
|--------|------|-------|
| `id` | TEXT PK | Short UUID, e.g. `"pool-a1b2c3"` |
| `statefulset_name` | TEXT | e.g. `"omb-worker"` or `"omb-worker-pool-a1b2c3"` |
| `service_name` | TEXT | Headless service name |
| `replicas` | INTEGER | Worker pod count at creation time |
| `status` | TEXT | `provisioning` / `ready` / `in_use` / `tearing_down` / `deleted` |
| `claimed_by_run_id` | INTEGER | Nullable |
| `created_at` | DATETIME | |
| `released_at` | DATETIME | Nullable |

**Default pool seed row** (inserted at `init_db` time, `INSERT OR IGNORE`):
```
id="default", statefulset_name="omb-worker", service_name="omb-worker", replicas=0, status="ready"
```
The default pool's `replicas` value is not used — actual count is always queried live from k8s. The default pool is never torn down.

### Modify: `runs` table

Add column: `worker_pool_id TEXT` (nullable; null means default pool for historical runs).

---

## Worker Pool Lifecycle

### At run start — `OmbRunner.start()`

1. Open a SQLite transaction; query for any run with `status = "running"`.
2. **If none active** → claim the default pool (`id="default"`), set `status="in_use"`, `claimed_by_run_id=run_id`. Proceed as today.
3. **If any active** → create a new concurrent pool:
   a. Read current replica count from the `omb-worker` StatefulSet (same k8s call as today).
   b. Generate `pool_id = short_uuid()`, e.g. `"pool-a1b2c3"`.
   c. Create StatefulSet `omb-worker-{pool_id}` by cloning the default spec: same image, resources, env, `hostNetwork`, `dnsPolicy`, node selector, tolerations, pod anti-affinity — only the name and service selector differ.
   d. Create headless Service `omb-worker-{pool_id}` selecting `app: omb-worker-{pool_id}`.
   e. Insert `worker_pools` row with `status="provisioning"`.
   f. Poll until all replicas report `Ready` (reuse existing pod-readiness polling in `omb_runner.py`).
   g. Update `status="in_use"`, `claimed_by_run_id=run_id`.
4. Store `worker_pool_id` on the run record.
5. Construct `--workers` URLs using the pool's names:
   ```python
   workers_arg = ",".join(
       f"http://{pool.statefulset_name}-{i}.{pool.service_name}.{namespace}.svc.cluster.local:{settings.omb_worker_port}"
       for i in range(pool.replicas)
   )
   ```
6. The `/stop-all` pre-flight probe targets this pool's workers (not all workers).

**Concurrency safety:** Steps 1–3e run inside a SQLite `BEGIN IMMEDIATE` transaction so two simultaneous run launches cannot both claim the default pool.

### At run complete — `_finish_run()`

1. If `run.worker_pool_id` is null or `"default"` → release claim only (set `claimed_by_run_id=NULL`, `status="ready"`). No k8s changes.
2. Otherwise → mark pool `status="ready"`, clear `claimed_by_run_id`, then call `schedule_teardown(pool_id, retention_minutes)`. This fires `asyncio.create_task` with an `asyncio.sleep(retention_minutes * 60)` before deleting the StatefulSet and Service. While the sleep is in progress, pods keep running and nodes stay provisioned — the CA has nothing to evict.
3. If `retention_minutes == 0` (Manual only) → no scheduled teardown. Pool stays alive until the SE explicitly releases it from the Cluster page.
4. If a new run claims the pool before the teardown task fires → `cancel_teardown(pool_id)` cancels the pending task. Pool transitions directly to `in_use` with no interruption.

**Teardown task registry:** `worker_pool_manager.py` maintains a module-level `dict[str, asyncio.Task]` mapping `pool_id → pending teardown task`. `schedule_teardown` inserts; `cancel_teardown` cancels and removes; the teardown coroutine removes itself on completion.

---

## RBAC Changes

`charts/omb/templates/rbac/role.yaml` — add to existing role:

| API Group | Resources | Add Verbs |
|-----------|-----------|-----------|
| `apps` | statefulsets | `create`, `delete` |
| `` (core) | services | `create`, `delete` |

---

## Execution Changes (`control-plane/services/omb_runner.py`)

Extract pool management into a new `services/worker_pool_manager.py`:
- `claim_pool(run_id, namespace) -> WorkerPool` — implements the claim/create logic above
- `schedule_teardown(pool_id, namespace, retention_minutes)` — schedules delayed StatefulSet + Service deletion via `asyncio.create_task`; retention_minutes=0 skips scheduling entirely
- `cancel_teardown(pool_id)` — cancels a pending teardown task when a pool is reclaimed
- `release_pool_now(pool_id, namespace)` — immediate teardown for manual release from Cluster page
- `build_workers_arg(pool, namespace, port) -> str` — constructs the `--workers` string

`OmbRunner.start()` calls `claim_pool` (cancelling any pending teardown for a reclaimed pool), stores result, then proceeds. `_finish_run` calls `schedule_teardown`. This keeps `omb_runner.py` at the same level of abstraction as today.

---

## Settings Changes

Add `concurrent_pool_retention_minutes` to the existing settings table (integer, default `30`). Special value `0` means "Manual only" — pools stay alive until explicitly released.

The existing `GET /api/settings` and `PUT /api/settings` endpoints carry this field automatically once added to the settings schema.

---

## New API Endpoints

| Method | Path | Purpose |
|--------|------|---------|
| `GET` | `/api/runs/{id}/concurrent` | Runs whose `started_at`/`completed_at` overlap with this run (excludes self and sweep siblings) |
| `GET` | `/api/runs/timeline` | All runs with `id`, `name`, `status`, `started_at`, `completed_at`, `warmup_started_at`, `benchmark_started_at`, `sweep_id`, `sweep_params` |
| `GET` | `/api/worker-pools` | All pool rows for the Cluster page |
| `POST` | `/api/worker-pools/{id}/release` | Manual immediate teardown (used by Cluster page "Release" button) |

Concurrent overlap query:
```sql
SELECT * FROM runs
WHERE id != :id
  AND started_at < :completed_at
  AND (completed_at IS NULL OR completed_at > :started_at)
```

---

## UI Changes

### New page: `/timeline` — `TimelinePage.jsx`

- Sidebar nav: "Timeline" as a sub-link under "Benchmark Runs" (same level as "+ New Run")
- Route in `App.jsx`: `/timeline → TimelinePage`
- Fetches `GET /api/runs/timeline` on mount
- SVG Gantt chart (no new dependency): time axis across the top, one row per run
- Each bar spans `started_at` → `completed_at`; in-progress bars extend to "now" with a pulse animation
- Bar color segments: gray (initializing) → blue (warmup) → green (benchmark)
- Sweep runs visually grouped: indented under their sweep with a shared left-border color
- Click any bar → navigate to `/runs/:id`

### `RunDetailPage` enhancement

- After run loads, fetch `GET /api/runs/{id}/concurrent`
- If results returned, render a "Concurrent Runs" panel (similar to existing sweep nav bar style): each entry shows run name, workload name, status badge, and a link
- Panel is hidden when no concurrent runs exist (no UI change for solo runs)

### `SettingsPage` enhancement

Add a **"Benchmark Behavior"** section (below Prometheus config) with:
- **Concurrent pool warm retention** — dropdown: 15 min / 30 min (default) / 1 hour / Manual only
- Help text: "How long concurrent worker pools stay provisioned after a run completes. Longer values avoid EC2 re-provision delays between runs."

### `ClusterPage` enhancement

- Add a "Worker Pools" table below the existing worker pod table
- Fetches `GET /api/worker-pools`
- Columns: Pool ID, StatefulSet, Replicas, Status, Claimed By (run id + link), "Release" button
- "Release" button calls `POST /api/worker-pools/{id}/release`; disabled on the default pool and on `in_use` pools
- Default pool row always present; concurrent pools appear with status (`ready` = warm, idle; `in_use` = benchmark running; `tearing_down` = countdown active)

---

## Database Migration (`database.py` — `init_db`)

```sql
-- safe idempotent additions (existing try/except pattern)
ALTER TABLE runs ADD COLUMN worker_pool_id TEXT;

CREATE TABLE IF NOT EXISTS worker_pools (
    id TEXT PRIMARY KEY,
    statefulset_name TEXT NOT NULL,
    service_name TEXT NOT NULL,
    replicas INTEGER NOT NULL DEFAULT 0,
    status TEXT NOT NULL DEFAULT 'ready',
    claimed_by_run_id INTEGER,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    released_at DATETIME
);

INSERT OR IGNORE INTO worker_pools (id, statefulset_name, service_name, status)
    VALUES ('default', 'omb-worker', 'omb-worker', 'ready');
```

---

## Implementation Steps

1. **RBAC + DB migration** — role.yaml, `init_db`, default pool seed, `concurrent_pool_retention_minutes` settings column. No behavior change. Deploy and verify schema.

2. **`services/worker_pool_manager.py`** — `claim_pool`, `schedule_teardown`, `cancel_teardown`, `release_pool_now`, `build_workers_arg`. Unit-testable with mocked k8s API. Includes SQLite transaction for concurrent-claim safety and teardown task registry.

3. **Wire into `omb_runner.py`** — `start()` calls `claim_pool` (cancels pending teardown if reclaiming), stores `worker_pool_id`, uses `build_workers_arg`. `/stop-all` probe scoped to pool's workers. `_finish_run` calls `schedule_teardown` with retention from settings.

4. **New API endpoints** — `/api/runs/{id}/concurrent`, `/api/runs/timeline`, `/api/worker-pools`, `POST /api/worker-pools/{id}/release` in appropriate routers.

5. **`SettingsPage` + settings schema** — add `concurrent_pool_retention_minutes` field and "Benchmark Behavior" section.

6. **`TimelinePage.jsx`** — SVG Gantt, route registration, sidebar nav entry.

7. **`RunDetailPage` + `ClusterPage` enhancements** — concurrent runs panel, worker pools table with Release button.

---

## Verification

1. **Solo run (backward compat):** Start a run → `run.worker_pool_id` is null → `kubectl -n omb get statefulsets` shows only `omb-worker` unchanged.

2. **Concurrent runs:** Start run A, then start run B while A is running:
   - `kubectl -n omb get statefulsets` shows `omb-worker-pool-{id}`
   - `kubectl -n omb get services` shows matching headless service
   - Run B's Job logs show workers connecting via the new pool's DNS names
   - After run B completes with retention=30 min: StatefulSet and Service still present; Cluster page shows pool status `ready`
   - After retention period expires: StatefulSet and Service deleted; run A unaffected

3. **Pool reclaim before teardown:** Run B completes (retention=30 min). Within 30 minutes, start run C → C claims B's pool; teardown task cancelled; no EC2 re-provision wait.

4. **Default pool release:** After run A completes (no concurrent activity): `worker_pools` row `id="default"` has `claimed_by_run_id=NULL`, `status="ready"`.

5. **Manual release:** Set retention to "Manual only". After run completes, pool stays alive indefinitely. Cluster page "Release" button tears it down immediately.

6. **Timeline page:** Both runs appear as overlapping bars. Click navigates to RunDetailPage.

7. **RunDetailPage concurrent panel:** Run A's page shows run B in the "Concurrent Runs" panel and vice versa.

8. **Background + sweep (falls out free):** Start a 60-minute solo run. Start a 5-iteration sweep while it's running. Sweep gets its own pool. Gantt shows long bar overlapping five sweep bars. No special handling required.
