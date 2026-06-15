# omb-k8s

A cloud-native benchmarking platform for Redpanda and Kafka-compatible clusters
using the OpenMessaging Benchmark (OMB) framework.

See `docs/architecture.md` for a full architectural reference before making
changes to the control plane, worker, Helm chart, or Terraform modules.

## Current environment

- **Cloud:** AWS (EKS)
- **Kubernetes namespace:** `omb`
- Use `kubectl -n omb` for all kubectl commands in this project.
- Use `helm install omb charts/omb -n omb ...` when deploying.

## Deliberate decisions not obvious from the code

**SASL password is stored plaintext in SQLite.** Encryption was removed because
the password ends up in a k8s ConfigMap anyway — encryption provided no real
security benefit and caused runs to break silently after pod restarts due to
ephemeral key rotation. The settings API returns `sasl_password` in GET responses
so `DriverForm` can embed it directly in the generated YAML.

**`sampleRateMillis` defaults to 1000 ms in WorkloadForm.** OMB's own default is
10 000 ms. The UI overrides this to 1000 ms for better live chart resolution. Do
not revert to 10 000 — SEs can increase it manually for very long runs.

## Frontend design decisions

**DriverForm and WorkloadForm never own YAML display.** Both are pure form inputs
that call `onChange` with the built YAML string. The parent (NewRunPage) holds
`driverYaml`/`workloadYaml` state and renders the YAML textareas. Do not add a
YAML preview or override/lock mechanism back — `isOverride = true` caused all
fields to lock on re-open.

**New Run and New Sweep share a single page at `/runs/new`.** A pill toggle enables
the Parameter Sweep section. `/sweeps/new` redirects here for backward compatibility.
Do not add a separate sweep form page.

**Parameter Sweep axes are split into Driver (left) and Workload (right) panels.**
Axes stored separately in localStorage as `workloadAxes` and `driverAxes`. The old
format (single `axes` array with a `type` field) is migrated on first read.

**`RunDetailPage` sweep nav bar behavior.**
- Each pill computes cooling state independently from `prevRun.completed_at +
  sweep.cooldown_seconds` — do NOT use the shared `cooldownRemaining` state.
- `wsSignaledDoneRef` is only set when `wsHasDataRef` is true — guards against
  false auto-advance when `is_done()` returns true for unregistered run IDs.
- `activeRunIdRef` prevents stale async callbacks: every `loadRun`/`pollUntilFinished`
  captures `expectedId` and checks it after every `await`. This fixed auto-advance
  misfires when navigating between sweep runs.
- Sweep nav chips do NOT clear on same-sweep navigation — `run`/`sweepRuns`/`sweep`
  state is only cleared when `run.sweep_id` goes falsy.

**SQLite datetimes are naive UTC — always append `'Z'` before `new Date(ts)` in
JavaScript** to avoid local-timezone misinterpretation.

**Do NOT seed `warmupStartedAt` from `run.started_at` in `loadRun`.** `started_at`
is Job creation time (JVM init), not the moment warmup traffic begins.

**RunCharts does not show latency charts.** Per-second rolling-window P99 cannot be
reconciled with the cumulative HDR P99 in FinalizedCharts. Latency is owned entirely
by FinalizedCharts post-completion.

**Backlog chart is clamped to ≥ 0** in both `normalizeTimeseries` and inline in
`RunCharts` when building `chartPoints` from live WebSocket data.

**Library drawer (`components/LibraryDrawer.jsx`) — all buttons inside must carry
`type="button"`.** The drawer renders inside a `<form>` element; untyped buttons
default to `type="submit"`.

## Driver and Workload form internals

Both forms use a key/value row model (`{_id, key, value}` rows). Do not convert
back to fixed named inputs.

**DriverForm** common config is **always regenerated from cluster Settings on form
init**, never from stored YAML. Collapsed behind a twisty by default.

**`producerConfig`, `consumerConfig`, `topicConfig`** must remain Java Properties
strings. `_apply_params` in `routers/sweeps.py` special-cases these: dot-notation
keys like `producerConfig.acks` are written as `key=value` lines within the string,
not as nested YAML keys. Changing to YAML nesting causes `MismatchedInputException`.

Utility modules:
- `lib/driverFormUtils.js` — `DRIVER_OPTIONS`, `KNOWN_PROP_OPTIONS`, `parseDriverYaml`,
  `buildDriverYaml`, `deriveProtocol`, `buildCommonConfigFromCluster`
- `lib/workloadFormUtils.js` — `DEFAULT_*_ROWS`, `parseWorkloadYamlToRows`,
  `buildWorkloadYaml`, `parseWorkloadYaml`

`parseWorkloadYaml` is re-exported from `workloadFormUtils.js` for use by
`RunDetailPage` — do not remove this re-export.

**Adding a smart dropdown to the driver form:** add one entry to `KNOWN_PROP_OPTIONS`
in `driverFormUtils.js` and a matching test in `driverFormUtils.test.js`. The
`PropertySection` component picks it up automatically.

## Future work specs

- `claude/hdr-live-latency.md` — live HDR P99 charts during a run
- `claude/ws-phase-events.md` — server-push phase events via WebSocket
