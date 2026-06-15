# control-plane

FastAPI backend + React frontend for the OMB k8s benchmarking platform.
This file supplements the root CLAUDE.md with decisions specific to this directory.

## Backend design decisions — do not reverse without discussion

**Long-running background tasks must use `asyncio.create_task()`, not FastAPI `BackgroundTasks`.**
FastAPI's `BackgroundTasks` awaits each task sequentially. `_finish_run` polls for
the entire benchmark duration (up to 4 hours), so if it is registered as a
`BackgroundTask`, any task registered after it will never start until the run
finishes. Do not change this back to `background_tasks.add_task()`.

**`launch_run()` in `routers/runs.py` is the single entry point for starting any run.**
It calls `runner.start()`, fires `collect_prometheus` as a non-blocking background
task, then either fires `_finish_run` as a background task (`await_finish=False`,
used by single runs) or awaits it inline (`await_finish=True`, used by sweeps for
sequential execution). Both `create_run` and `_execute_sweep` call `launch_run` —
do not duplicate the three-step sequence elsewhere.

**Worker pools are SE-managed, not auto-provisioned.** `create_run` takes a
`pool_id` in the request body (selected from the **Worker Pool** dropdown on
NewRunPage). It returns immediately with `status="pending"` and fires
`_bg_launch` as an `asyncio.create_task`. `services/worker_pool_manager.py::claim_pool(pool_id, run_id)`
marks an existing `ready` pool as `in_use` — it does NOT create a new StatefulSet.
New pools are created by the SE from the **OMB Cluster** page
(`POST /api/worker-pools`), which calls `create_pool()` to provision a new
StatefulSet and headless Service. If no ready pool exists when a run is launched,
the UI blocks with "No worker pools are available. Create one on the Cluster page
before launching a run." Do not return a blocking HTTP response from `create_run`
— pool provisioning on a cold node takes up to 10 minutes and the browser will
time out and retry, creating duplicate runs. There is no auto-provisioning or
warm-retention logic in `worker_pool_manager.py`.

**Worker pool state transitions use Core-style `db.execute(update(...).values(...))`.**
Never use ORM attribute mutation followed by `db.expunge()` — the expunge pattern
silently drops attribute changes before commit. `claim_pool` returns a fresh
`WorkerPool` object (not the ORM instance) after every Core-style update.
Non-default pools can be deleted from the Cluster page when they are in `ready`
state. The default pool (`id="default"`, `statefulset_name="omb-worker"`) is
always present and is never deleted.

**SASL password is stored plaintext in SQLite.** Encryption was removed because
the password ends up in a k8s ConfigMap anyway — encryption provided no real
security benefit and caused runs to break silently after pod restarts due to
ephemeral key rotation. The settings API returns `sasl_password` in GET responses
so `DriverForm` can embed it directly in the generated YAML.

**Settings page has no BYOC/self-hosted distinction.** The cluster connectivity tab
is a single unified form — seed broker chips, TLS toggle, SASL toggle + mechanism.
BYOC and self-hosted both work identically once TLS and SASL are configured; the
distinction was removed as unnecessary complexity. The Prometheus tab accepts either
comma-separated `scrape_targets` (self-hosted, e.g. `broker:9644`) or a full
Prometheus scrape job YAML (`scrape_yaml`, for BYOC with basic_auth). At run start,
`_load_broker_targets()` in `routers/runs.py` reads whichever is configured and fires
`probe_broker_prometheus()` as a background task — this GETs `/metrics` from each
target and logs a sample of metric names for diagnostics. No broker metrics are stored
or displayed yet; chart integration is a future phase.

**`sampleRateMillis` defaults to 1000 ms in WorkloadForm.** OMB's own default is
10 000 ms (one stat line every 10 s). The UI default overrides this to 1000 ms
(one stat line per second) for better live chart resolution. The final aggregated
stats (p50/p99/etc.) come from a cumulative histogram and are unaffected by this
value. Do not revert to 10 000 — SEs can increase it manually for very long runs
where log volume is a concern.

## OMB runtime quirks — do not remove these workarounds

**`--output` is required.** This OMB build calls `new File(output)` unconditionally
in `WorkloadGenerator.run()` before checking for null. Omitting `--output` causes
an immediate NPE. The output is written to `/data/results/run-{id}` on the
control-plane PVC. `_finish_run` reads this file for high-fidelity results (full
per-second arrays), falls back to log parsing if absent, then renames the file to
`run-{id}.json` or `sweep-{sweep_id}-run-{id}.json`. Files are inspectable via
`kubectl exec -n omb <control-plane-pod> -- ls /data/results/` and copyable to
local with `kubectl cp -n omb <control-plane-pod>:/data/results/run-{id}.json ./run-{id}.json`.
Do not change `--output` back to `/tmp` — that path is ephemeral and inaccessible
after the container exits.

**`topicConfig: ""` is required in driver YAML.** `Config.topicConfig` has no Java
default value. If absent from the driver YAML, Jackson leaves it null and
`new StringReader(null)` NPEs at driver init. Always emit `topicConfig: ""`.
When setting actual topic config values, use Java Properties format (`key=value`),
not YAML syntax (`key: value`). Example: `topicConfig: "retention.ms=600000"`.
Using YAML key-value syntax causes a Jackson `MismatchedInputException`.

**`payloadFile` must always be set and point to a file with exactly `messageSize`
bytes.** This OMB build calls `new File(payloadFile)` unconditionally and then
enforces an exact byte-count match. The init container generates the file at
`/payload/payload.data` so any arbitrary `messageSize` works. Do not remove the
init container or change the path without understanding this constraint.

**Worker pods can get stuck after a cancelled run.** When a run is cancelled
mid-flight, the OMB worker's internal Java process may be left in an error state.
`OmbRunner.start()` probes every worker via `POST /stop-all` before creating the
ConfigMap or Job. A healthy idle worker returns 200; a stuck worker returns 500.
If any worker fails the probe, `start()` raises a `RuntimeError` with a clear
message naming the worker, which surfaces as an HTTP 503 to the UI for single runs
or a failed run entry for sweeps. The Cluster tab shows a red health dot on
unreachable workers and provides a ↺ restart button on every pod row. Restarting
the worker pod clears the state; the StatefulSet controller recreates it
immediately.

**`producerConfig`, `consumerConfig`, and `topicConfig` in driver YAML must remain
Java Properties strings, not YAML objects.** Jackson deserializes these fields as
`String`, not `Map`. If sweep parameter overrides (e.g. `producerConfig.acks`)
are applied by converting them to YAML nested keys, Jackson throws
`MismatchedInputException` at driver init. `_apply_params` in `routers/sweeps.py`
special-cases these three fields: dot-separated keys like `producerConfig.acks`
are parsed as `key=value` property lines within the existing string value rather
than being set as nested YAML keys. Do not change this to YAML nesting.

## SQLite database

The SQLite database file is at `/data/omb_ui.db` inside the control-plane pod
(mounted from the PersistentVolume). The path is **not** `/data/omb.db`.

## Worker memory and JVM settings

Worker pod CPU and memory are set via `worker.resources.cpu` and `worker.resources.memory`
in the Helm values. Per-cloud defaults are in `values-aws.yaml`, `values-gcp.yaml`, and
`values-aks.yaml`. To use a different instance type, update the Terraform instance type and
these two Helm values — nothing else needs to change.

No CPU *limit* is set on worker pods (only a request). This prevents cgroup CPU throttling
architecturally. The memory limit equals the memory request.

Required JVM flags in the entrypoint script (do not add -Xms/-Xmx):
  -XX:InitialRAMPercentage=75.0
  -XX:MaxRAMPercentage=75.0
  -XX:+UseContainerSupport
  -XX:+UseG1GC
  -XX:MaxGCPauseMillis=10
  -XX:+ParallelRefProcEnabled
  -XX:+PerfDisableSharedMem
  -XX:+DisableExplicitGC
  -XX:MinHeapFreeRatio=10
  -XX:MaxHeapFreeRatio=20

-XX:+UseContainerSupport causes the JVM to read cgroup memory limits. Combined with
MaxRAMPercentage=75.0 this produces heap = 75% of container memory automatically.
MinHeapFreeRatio=10 / MaxHeapFreeRatio=20 causes G1GC to shrink the committed heap
back toward the live set after a large run completes, so worker memory charts reflect
actual usage rather than the high-water mark from a prior run.

## UI navigation structure

The frontend is a React SPA served by FastAPI. A sticky left sidebar (220px)
handles all navigation. Routes and pages:

| Route | Page | Purpose |
|-------|------|---------|
| `/` | RunsPage | Results-only list of completed and active runs |
| `/runs/new` | NewRunPage | Configure and launch a run or sweep; prefills from last run on mount |
| `/runs/:id` | RunDetailPage | Live log streaming, real-time charts, final metrics; sweep nav bar when run belongs to a sweep |
| `/sweeps` | SweepsPage | Parameter sweep list; rows clickable; columns: name, status, run count, Best Pub P99, Best E2E P99 |
| `/sweeps/new` | NewSweepPage | Redirects to `/runs/new` with `state={{ enableSweep: true }}` |
| `/sweeps/:id` | SweepDetailPage | Sweep overview — sortable run comparison table; rows clickable; two-row sticky super-header groups sweep parameter columns; checkbox-driven percentile curve charts + heatmap (capped at 10 runs); Grafana link above table |
| `/workloads` | WorkloadLibraryPage | Workload and driver library — two tabs (Workloads / Drivers); full CRUD for custom entries; bundled entries are read-only |
| `/settings` | SettingsPage | Cluster connectivity (seed brokers, TLS, SASL) + Prometheus scrape targets |
| `/cluster` | ClusterPage | k8s cluster status, worker health, pod restart; Worker Pools table with idle countdown and Release button |
| `/timeline` | TimelinePage | SVG Gantt chart of all runs; zoom/scroll with 1-hour default window; bars colored by phase |

Sidebar nav groups:
- **Main:** Benchmark Runs → (sub) + New Run / Sweeps / Workload Library / Timeline
- **Infrastructure** (below divider): OMB Cluster / Settings
- **Bottom:** Worker scaling control (label + readiness badge + input + Scale button)

## Key frontend design decisions — do not reverse without discussion

**DriverForm and WorkloadForm never own YAML display.** Both components are
pure form inputs — they call `onChange` with the built YAML string whenever a
field changes. The parent page (NewRunPage) holds `driverYaml`/`workloadYaml`
state and renders the YAML textareas itself. Do not add a YAML preview or
override/lock mechanism back into these components — it was removed because
`isOverride = true` caused all fields to lock on re-open.

**New Run and Benchmark Runs are separate pages.** `/runs/new` (NewRunPage) is
the form; `/` (RunsPage) is the results list. They were split because having
the form toggle on the results page created confusing UX. WorkloadLibrary
navigates to `/runs/new` with `location.state` to prefill the workload.

**New Run and New Sweep share a single page at `/runs/new`.** `NewRunPage` has a
pill toggle switch that enables the Parameter Sweep section. When the toggle is
off, submit creates a single run. When on and at least one axis has values, submit
creates a sweep. The sweep section sits above the driver/workload panels and
auto-expands when localStorage contains saved axes with values. `/sweeps/new` is
kept as a redirect to `/runs/new?state={enableSweep:true}` for backward
compatibility (bookmarks). Do not add a separate sweep form page.

**Parameter Sweep axes are split into Driver (left) and Workload (right) panels.**
Each panel has its own field dropdown (from a fixed list + "Custom…" escape hatch)
and chip inputs. There is no per-row type dropdown. Axes are stored separately in
localStorage as `workloadAxes` and `driverAxes`. The old format (single `axes`
array with a `type` field) is migrated on first read. The sweep section defaults to
disabled on page load regardless of saved axes — it only auto-enables when navigating
from `/sweeps/new`. Individual axes can be deleted down to zero per panel.

**Launching a run or sweep navigates immediately to the execution page.**
`NewRunPage` navigates to `/runs/:id` after `createRun` returns, or fetches
`getSweepRuns(sweep.id)` after `createSweep` and navigates to the first run's
`/runs/:id` (or `/sweeps/:id` if no runs exist yet).

**`RunDetailPage` shows a sweep nav bar when the run belongs to a sweep.**
If `run.sweep_id` is set, the page fetches sibling runs via `getSweepRuns` and
renders a horizontal pill strip above the page header. Each pill shows the sweep
parameter values for that run (e.g. `acks=0`) and uses CSS glow animations to
reflect live state: running pills glow green, the pending run in cooldown glows
ice blue, failed pills are red with no glow. Each pill computes its cooling state
independently from `prevRun.completed_at + sweep.cooldown_seconds` vs `Date.now()`
— do NOT use the shared `cooldownRemaining` state for this, it is only valid for
the currently viewed run. Pills poll every 3 s while any sibling is still running
or pending. When the current run transitions out of `running` AND the WebSocket
signaled completion (`wsSignaledDoneRef`), the page auto-advances to the next
sibling run. `wsSignaledDoneRef` is only set when `wsHasDataRef` is true — this
guards against a race where `is_done()` returns true for unregistered run IDs,
which would otherwise trigger false auto-advance when viewing a pending run that
just transitioned to running. Do not add per-run detail logic to `SweepDetailPage`
— it is a comparison table only; `RunDetailPage` is the shared execution view for
both single runs and sweep runs.

**Sweep nav chips stay visible during same-sweep navigation.** The reset effect
(`useEffect([id])`) deliberately does NOT clear `run`, `sweepRuns`, or `sweep`
state, so chips remain rendered while the new run loads. A stale-run guard in the
WS effect (`if (run.id !== Number(id)) return`) prevents the old run's WebSocket
from opening. `sweepRuns`/`sweep` are cleared only when `run.sweep_id` goes
falsy (user leaves the sweep entirely).

**`activeRunIdRef` prevents stale async callbacks from contaminating navigation.**
Every `loadRun` and `pollUntilFinished` call captures `expectedId = Number(id)`
at call time and checks `activeRunIdRef.current !== expectedId` after every
`await`. The reset effect sets `activeRunIdRef.current = Number(id)` before
calling `loadRun`. This prevents the WebSocket `onclose` handler of a prior run
from calling `setRun` on the new run's page, which was the root cause of
auto-advance misfires when navigating between sweep runs.

**`RunDetailPage` shows a cooldown countdown between sweep runs.** When the
current run is completed and the next run is pending, or when the current run is
pending and the previous run just completed, a 🧊 countdown badge appears in the
sweep nav bar. The timer is anchored to `run.completed_at + sweep.cooldown_seconds`
from the server, so it is accurate after navigation. SQLite stores naive UTC
datetimes without 'Z'; always append 'Z' before `new Date(ts)` in JavaScript to
avoid local-timezone misinterpretation.

**RunCharts renders per-worker CPU, memory, and network series.** The Worker CPU,
Worker Memory, and Worker Network Tx charts each show one `<Line>` per pod using
the `worker_cpu_per_pod` / `worker_memory_per_pod` / `worker_net_tx_per_pod` JSON
columns from `prometheus_samples`. If CPU/memory columns are absent (old runs), those
charts fall back to the averaged `workerCpuPct` / `workerMemMiB` columns. The Worker
Network Tx chart is only rendered when `worker_net_tx_per_pod` data is present
(`hasNetworkMetrics`); the worker row is 3-column when network data exists, 2-column
otherwise. Network Tx stores raw bytes/sec; `tickFormatter` and tooltip `formatter`
divide by 1_048_576 to display MB/s. Memory y-axis is in GiB (data stays in MiB;
`tickFormatter` divides by 1024). An amber alert banner fires when any pod has nonzero
`worker_net_drop_per_pod` values, listing each affected pod and its peak drops/sec.
Pod list for all worker charts is derived from `workerMem_*` keys (`workerPods`). All
chart x-axes show local time; SQLite datetimes always need `+Z` appended before
`new Date()` to parse as UTC correctly.

**RunCharts does not show latency charts.** Per-second log-emitted latency stats
(rolling window P99) cannot be reconciled with the cumulative HDR P99 in
FinalizedCharts, so they were removed to avoid confusion. Latency is owned
entirely by FinalizedCharts post-completion. Live HDR latency during a run is
planned — see `claude/hdr-live-latency.md`.

**RunCharts expected-rate reference lines.** `RunDetailPage` computes `expectedMsgSec`
and `expectedMBSec` from `workload_config.producerRate` and `messageSize`, and
`expectedConsMsgSec`/`expectedConsMBSec` by multiplying by `subscriptionsPerTopic`.
These are passed as props to `RunCharts` which renders amber dashed `ReferenceLine`
components on the Throughput (msg/s) and Throughput (MB/s) charts. A green dashed
consume reference line is added only when consume rate differs from publish rate
(i.e. `subscriptionsPerTopic > 1`). The y-axis domain is `[0, niceMax(max(dataMax,
expectedRate))]` — `niceMax` adds 15% headroom and rounds to half-magnitude steps
so the axis stays snug while still showing reference lines when target > actual.

**RunCharts CPU saturation alert.** An amber alert banner fires when any worker's CPU
exceeds 85% of its CPU request (uses per-pod `workerCpu_*` keys, falls back to the
aggregate `workerCpuPct`). A dashed amber reference line at 85% and a solid red line
at 100% mark the chart. The 85% threshold is intentional — without a CPU limit,
cgroup throttling never fires; resource exhaustion instead degrades throughput silently.

**Backlog chart is clamped to ≥ 0.** `normalizeTimeseries` applies `Math.max(0, v)`
to stored backlog values. `RunCharts` applies the same clamp inline when building
`chartPoints` from `livePoints`, since livePoints arrive raw from the WebSocket parser
and bypass `normalizeTimeseries`.

**RunDetailPage post-completion view shows finalized HDR charts.** When a run
completes, the page switches to a finalized view: (1) 2-column throughput tiles
(publish rate + consume rate, actual vs target) sized to content (`inline-grid`);
(2) `FinalizedCharts` component with the nines table, HDR percentile curves
(nines-transformed log x-axis), and latency histograms — all badged `omb`;
(3) `RunCharts` showing throughput/backlog/worker charts from stored metrics.
The Run Log auto-collapses on completion and has a `▶`/`▼` twisty indicator.
`FinalizedCharts` no longer shows a per-second latency time series — those stats
are not reconcilable with the cumulative HDR P99. `FinalizedCharts` receives
`results` from `GET /api/runs/{id}/results` (polled with retries after completion).
HDR results are also stored in the `run_results` SQLite table by
`parse_and_store_hdr_results` (triggered async from `_finish_run`). `MetricCard`
accepts an `expected` prop; if actual < 95% of expected the value renders red,
≥ 95% renders green. All charts and tiles carry a source badge (`omb`, `redpanda`,
or `worker`) identifying the data origin.

**Timeline page (`/timeline`) is a zoomable SVG Gantt chart of all runs.** Fetches
`GET /api/runs/timeline`. The default view window is `now − 1 hour` to `now + 1 min`.
Bars are colored by phase (gray = initializing, blue = warmup, green = benchmark).
In-progress bars extend to "now" with a pulse animation. Sweep runs are indented under
their sweep with a shared left border. Click any bar navigates to `/runs/:id`. Scroll
wheel zooms centered on mouse X; click-drag pans. Preset buttons: 1h, 3h, 6h, All.
No new library dependency — pure SVG with `clipPath` to clip bars at view boundaries.

**Cluster page shows image digest per pod.** The `/api/cluster/pods` endpoint extracts
`container_statuses[0].image_id` and parses the sha256 digest (first 12 chars) as
`image_hash`. Falls back to `image_ref` (the full image tag string) if the digest
format is absent. Displayed as a small subtitle under each pod name in the table.

**Cluster page Worker Pools table shows all non-deleted pools.** `GET /api/worker-pools`
returns all non-deleted pools. Columns: Pool name, StatefulSet, Replicas, Status,
Claimed By (run link), scale controls (input + Scale button), Delete button.
The Delete button is only enabled when a pool is in `ready` state and is not the
default pool. The Scale button works when a pool is `ready` (not `in_use`,
`provisioning`, or `tearing_down`). A **Create Worker Pool** form above the table
accepts a name and replica count and calls `POST /api/worker-pools`.

**Status badges in `RunDetailPage` reflect live run sub-phases.** While
`run.status === 'running'`, a finer-grained `displayStatus` is derived from live
log parse state: `initializing` (purple, before warmup traffic log line), `warmup`
(blue, after "Starting warm-up traffic"), `running` (green, after "Starting
benchmark traffic"). During cooldown: `cooldown` (cyan). Pending sweep runs:
`queued` (gray). Do NOT seed `warmupStartedAt` from `run.started_at` in
`loadRun` — `started_at` is the Job creation time (JVM init), not the moment
warmup traffic begins, which would incorrectly show "warming up" during
initializing.

**`warmup_started_at` and `benchmark_started_at` are stored in the `runs` table.**
When the backend detects "Starting warm-up traffic" / "Starting benchmark traffic"
in the log stream, it writes UTC timestamps to these columns via `_record_phase_ts`
in `omb_runner.py`. `loadRun` seeds `warmupStartedAt`/`benchmarkStartedAt` state
from these server values so the progress bar is accurate after navigation. The WS
handler guards with `prev => prev ?? Date.now()` so replayed log lines never
overwrite the server-anchored timestamps. Both columns are added by ALTER TABLE
migrations in `init_db`.

**NewRunPage prefills from the most recent run.** On mount it calls `listRuns`
then `getRun(runs[0].id)` to seed `initialDriverContent` and
`initialWorkload`. If navigating from WorkloadLibrary (`location.state?.workloadContent`),
the prefill fetch is skipped and the library content is used instead. If
`driverInitOverride` or `workloadInitOverride` state is set (from the in-page
library drawer), those values take precedence over both paths.

**NewRunPage layout: sweep section above the 2×2 panel grid.** The page renders
top-to-bottom: (1) header card with name, launch button, and projected load
(including runtime estimate: warmup + bench duration per run, total sweep time);
(2) Parameter Sweep card with toggle, cooldown input, and Driver (left) + Workload
(right) axis panels; (3) 2×2 CSS grid — top row: Driver form panel (blue accent) +
Workload form panel (green accent), each with a `PanelHeader` that includes a
"Browse library" button; bottom row: Driver YAML panel + Workload YAML panel
(darker `#0d1018`). The form is constrained to `maxWidth: 1400px, margin: 0 auto`.

**Library drawer (`components/LibraryDrawer.jsx`) replaces navigation to the library page.**
Each panel header has a "Browse library" button that opens a fixed 440px right-side
drawer with a semi-transparent backdrop. The drawer fetches `/api/drivers` or
`/api/workloads` on open and shows bundled + custom sections. Clicking an entry
toggles an inline YAML preview; "Use this config" calls `onApply(content, name)`.
The parent (`NewRunPage`) sets `driverInitOverride`/`workloadInitOverride`, sets the
YAML state directly, and increments `driverFormKey`/`workloadFormKey` to force the
form to re-mount with the new `initialYaml`. A `window.confirm` fires if the form
already has content. All buttons inside the drawer must carry `type="button"` — the
drawer renders inside the `<form>` element and untyped buttons default to `type="submit"`.

## Future work specs

- `claude/hdr-live-latency.md` — live HDR P99 charts during a run by polling
  `/cumulative-latencies` on worker pods (same data as final output)
- `claude/ws-phase-events.md` — server-push phase events via WebSocket to
  eliminate client-side state inference and race conditions in sweep navigation

## Driver and Workload form architecture

Both forms use a **key/value row model** — each config section is a list of
`{_id, key, value}` rows rendered by a `PropertySection` / `WorkloadSection`
component. Do not convert them back to fixed named inputs.

**DriverForm** (`components/DriverForm.jsx`) sections:
- Topic Config → `topicConfig` YAML block scalar
- Producer Config → `producerConfig` YAML block scalar
- Consumer Config → `consumerConfig` YAML block scalar
- Common Config → `commonConfig` YAML block scalar — **always regenerated from
  cluster Settings on form init, never from stored YAML**. Stored YAML uses
  `yaml.dump()` format which the manual parser only partially handles. Collapsed
  behind a `▶ COMMON CONFIG` twisty by default; expand to edit SASL overrides.

**WorkloadForm** (`components/WorkloadForm.jsx`) sections: Topology, Load, Timing,
Payload, Additional. All sections serialize to flat `key: value` YAML lines.
`parseWorkloadYaml` (the backward-compat export used by `RunDetailPage`) is
re-exported from `workloadFormUtils.js` — do not remove this re-export.

**Utility modules:**
- `lib/driverFormUtils.js` — `DRIVER_OPTIONS`, `KNOWN_PROP_OPTIONS`,
  `parseDriverYaml`, `buildDriverYaml`, `deriveProtocol`, `buildCommonConfigFromCluster`
- `lib/workloadFormUtils.js` — `DEFAULT_*_ROWS`, `WORKLOAD_KNOWN_PROP_OPTIONS`,
  `WORKLOAD_KNOWN_PROP_TYPES`, `WORKLOAD_PROP_HINTS`, `parseWorkloadYamlToRows`,
  `buildWorkloadYaml`, `parseWorkloadYaml`

**Adding a new smart dropdown to the driver form:** add one entry to
`KNOWN_PROP_OPTIONS` in `driverFormUtils.js` and a matching test in
`driverFormUtils.test.js`. The `PropertySection` component picks it up
automatically — no other changes needed.

**`useRandomizedPayloads` is a toggle type** in `WORKLOAD_KNOWN_PROP_OPTIONS`.
`randomizedPayloadPoolSize` is dimmed and suppressed from YAML output when
`useRandomizedPayloads` is `'false'`. Both rows are always injected into the
Payload section at init time regardless of what was in stored YAML.

**Section divider colors:** driver form uses indigo `#818cf8`; workload form uses
green `#4ade80`. Both use the same `LABEL ———` flex-row visual pattern.

## Driver library

`/api/drivers` mirrors `/api/workloads` exactly — same `{bundled, custom}` response
shape, same CRUD endpoints, same `is_bundled` read-only guard. The `Driver` model
lives in `models.py`; schemas (`DriverOut`, `DriverCreate`, `DriverUpdate`) in
`schemas.py`; router in `routers/drivers.py`.

Five bundled driver YAMLs live in `control-plane/drivers/` and are copied into the
image at `/app/drivers/` by the Dockerfile. `seed_bundled_drivers()` in
`services/seeder.py` seeds them on first startup (no-ops if any bundled driver row
exists). Driver names: `kafka-acks-1-throughput`, `kafka-acks-all-durable`,
`kafka-acks-1-low-latency`, `redpanda-acks-all-throughput`, `redpanda-acks-all-strict`.

Do not add `last_used_at` or `last_used_run_id` to the Driver model — drivers are
referenced by content, not by run history (unlike workloads).
