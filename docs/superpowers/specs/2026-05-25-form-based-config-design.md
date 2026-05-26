# Design: Form-Based Configuration & Bootstrap Banner

**Date:** 2026-05-25
**Status:** Approved, pending implementation plan

## Problem

The current UI requires SEs to manually edit raw YAML for every run, including re-entering
broker addresses and credentials each time. The Prometheus BYOC settings schema uses a
remote-write model that doesn't match what Redpanda Cloud actually provides (a scrape job
YAML block). The sweep axis builder requires typing field names by hand.

## What We're Building

1. **Bootstrap banner** — detects unconfigured cluster, guides SE to Settings before first run
2. **Settings: Prometheus BYOC** — paste a scrape job YAML block instead of individual fields
3. **Driver form** — connection section auto-populated from Settings; per-run fields as form inputs; live YAML preview
4. **Workload form** — standard fields as inputs; projected load calculator; [+] for custom fields; live YAML preview
5. **Sweep axes** — dropdown of known fields from both forms, grouped by file; custom free-text fallback

## Architecture Decision

**Frontend-driven YAML generation.** Form values + stored settings → YAML string built entirely
in the browser. No new backend endpoints needed for YAML assembly. The one backend change is
updating the Prometheus settings schema for BYOC (store raw scrape YAML instead of
remote_write_url / remote_write_username / remote_write_password).

---

## Section 1: Bootstrap Banner

When `GET /api/settings` returns `cluster: null`, a persistent banner appears at the top of
the content area on every screen:

```
⚠  Cluster not configured. Add broker address and credentials in Settings
   before running benchmarks.                        [Go to Settings →]
```

**Behavior:**
- Dismissible per-session (not permanently — reappears on reload until settings are saved)
- Run and sweep launch buttons disabled with tooltip "Configure cluster settings first"
- Prometheus is optional — no banner for missing Prometheus config
- Banner disappears immediately once cluster settings are saved (settings context re-fetches)

---

## Section 2: Settings — Prometheus BYOC

Replace the three individual BYOC Prometheus fields (remote_write_url, remote_write_username,
remote_write_password) with a single textarea that accepts the full scrape job YAML block
provided by the Redpanda Cloud UI.

**BYOC tab UI:**
```
Paste the scrape job YAML from Redpanda Cloud UI → Metrics → Prometheus:
┌──────────────────────────────────────────────────────────────────┐
│ - job_name: redpandaCloud-...                                    │
│   static_configs:                                                │
│     - targets: [...]                                             │
│   basic_auth:                                                    │
│     username: prometheus                                         │
│     password: ••••••••                                           │
└──────────────────────────────────────────────────────────────────┘
[Save & Apply]
```

**Password masking:** On load, if a scrape YAML was previously saved, the password value
within the YAML is replaced with `••••••••` in the displayed text. Clicking into the
textarea reveals the real value for editing.

**Self-hosted tab:** Unchanged — comma-separated scrape targets list.

**Backend change:** The `prometheus` settings row for BYOC mode stores a single
`scrape_yaml` string field instead of `remote_write_url / remote_write_username /
remote_write_password`. Self-hosted storage unchanged (`scrape_targets_str`).

Updated `PrometheusConfig` schema:
```python
class PrometheusConfig(BaseModel):
    mode: str  # "byoc" | "self-hosted"
    scrape_yaml: Optional[str] = None          # BYOC: full scrape job YAML block (password redacted)
    scrape_yaml_password: Optional[str] = None # BYOC: encrypted password extracted from scrape YAML
    scrape_targets: Optional[List[str]] = None # self-hosted, comma-separated
```

**Password handling for BYOC scrape YAML:**
On PUT, the backend parses the submitted YAML, extracts the `basic_auth.password` value,
encrypts it, and stores it in `scrape_yaml_password`. The `scrape_yaml` field is stored
with `password: __REDACTED__` as a sentinel. On GET, the decrypted password is
re-injected into the YAML before returning to the frontend (which then masks it as
`••••••••` in the textarea). This keeps the encryption-at-rest pattern consistent with
how `sasl_password` is handled.

---

## Section 3: Driver Form

The run/sweep driver section splits into a read-only connection area (auto-populated from
Settings) and an editable per-run fields area. A live YAML preview is shown below both.

**Layout:**
```
Driver Configuration
──────────────────────────────────────────────────────────────────
CONNECTION  (from Settings — edit in Settings to change)
  Brokers:   seed-abc.byoc.prd.cloud.redpanda.com:9092
  Protocol:  SASL_SSL    Mechanism: SCRAM-SHA-256
  Username:  craig@redpanda.com

[No settings configured — go to Settings to add broker details]  ← if missing

PER-RUN SETTINGS
  Driver            [Redpanda ▾]    Replication Factor  [3]
  acks              [all ▾]    linger.ms  [1]    batch.size  [131072]
  auto.offset.reset [earliest ▾]    auto.commit  [ ] enabled

[+ Add field]

▼ YAML Preview (editable — overrides form above)
  name: Redpanda
  driverClass: io.openmessaging.benchmark.driver.redpanda.RedpandaBenchmarkDriver
  replicationFactor: 3
  commonConfig: |
    bootstrap.servers=seed-abc...:9092
    security.protocol=SASL_SSL
    ...
```

**Driver dropdown values:**
- Redpanda → `io.openmessaging.benchmark.driver.redpanda.RedpandaBenchmarkDriver`
- Kafka → `io.openmessaging.benchmark.driver.kafka.KafkaBenchmarkDriver`

**YAML generation:** Connection fields (commonConfig block) are assembled from stored
settings at render time. Per-run fields map to top-level YAML keys and config blocks.

**Override behavior:** Editing the YAML preview directly marks it "manually overridden" —
form fields become read-only with a "Reset to form" button. The overridden YAML is what
gets submitted to the run API.

**[+ Add field]:** Appends a `key: value` row. User specifies which section the field
belongs to (top-level, producerConfig, consumerConfig, topicConfig). Merges into YAML preview.

---

## Section 4: Workload Form

Standard OMB workload fields as form inputs, with projected load calculator and live YAML preview.

**Standard fields:**

| Section  | Field                   | Type   | Default |
|----------|-------------------------|--------|---------|
| Topology | topics                  | number | 1       |
| Topology | partitionsPerTopic      | number | 100     |
| Topology | producersPerTopic       | number | 4       |
| Topology | consumerPerSubscription | number | 1       |
| Topology | subscriptionCount       | number | 1       |
| Load     | messageSize             | bytes  | 1024    |
| Load     | producerRate            | msg/s  | 100000  |
| Load     | consumerBacklogSizeGB   | number | 0       |
| Timing   | warmupDurationMinutes   | number | 1       |
| Timing   | testDurationMinutes     | number | 5       |

**Projected Load calculator** (updates live):
```
PROJECTED LOAD
  Total        100,000 msg/s    97.7 MB/s
  Per producer  25,000 msg/s    24.4 MB/s
```
- Total MB/s = `producerRate × messageSize / 1,048,576`
- Per-producer msg/s = `producerRate / (producersPerTopic × topics)`
- Per-producer MB/s = per-producer msg/s × messageSize / 1,048,576

**[+ Add field]:** Appends a free-form `key: value` row that gets merged into the YAML.

**YAML preview:** Same override behavior as driver form — editing locks the form.

**Used in three places:**
1. Creating a new custom workload in Workload Library
2. Editing an existing custom workload in Workload Library
3. The workload section on the run/sweep creation form

---

## Section 5: Sweep Parameter Axes

[+ Add axis] opens a grouped dropdown instead of a free-text field:

```
— Workload ———————————————
  partitionsPerTopic
  messageSize
  producerRate
  producersPerTopic
  topics
  subscriptionCount
  consumerPerSubscription
  consumerBacklogSizeGB
  testDurationMinutes
  warmupDurationMinutes
— Driver —————————————————
  replicationFactor
  producerConfig.acks
  producerConfig.linger.ms
  producerConfig.batch.size
  consumerConfig.auto.offset.reset
— Custom —————————————————
  [Type a field name...]
```

Each axis row displays a "Workload:" or "Driver:" prefix so the SE knows which YAML the
override applies to. The backend sweep runner already applies overrides by top-level key
name to the workload YAML — it will need a parallel mechanism for driver YAML overrides.

**Backend change:** `SweepCreate` body needs to distinguish driver parameter axes from
workload parameter axes so each run gets the right YAML modified:
```python
class SweepCreate(BaseModel):
    ...
    workload_parameter_axes: Dict[str, Any]       # replaces parameter_axes
    driver_parameter_axes: Dict[str, Any] = {}    # new
    parameter_axes: Optional[Dict[str, Any]] = None  # deprecated, kept for backward compat
```

The router treats `parameter_axes` (old field) as `workload_parameter_axes` if the new
field is absent, so existing sweep calls from the frontend continue to work during the
transition. Once the frontend is updated, the deprecated field can be removed.

---

## Files Changed

**Frontend:**
- `src/context/SettingsContext.jsx` — new, provides settings + cluster config to all components
- `src/components/Layout.jsx` — add bootstrap banner
- `src/components/DriverForm.jsx` — new shared component
- `src/components/WorkloadForm.jsx` — new shared component
- `src/pages/SettingsPage.jsx` — update Prometheus BYOC tab
- `src/pages/RunsPage.jsx` — replace YAML textareas with DriverForm + WorkloadForm
- `src/pages/SweepsPage.jsx` — replace YAML textareas + axes with form components + dropdown
- `src/pages/WorkloadLibraryPage.jsx` — replace inline editor with WorkloadForm

**Backend:**
- `schemas.py` — update `PrometheusConfig`, update `SweepCreate`
- `routers/settings.py` — update Prometheus BYOC storage/retrieval
- `routers/sweeps.py` — apply driver parameter axes to driver YAML per run
- `services/encryption.py` — extract + encrypt password from scrape YAML

---

## Out of Scope

- Changing the run results or metrics display
- Adding new API endpoints for YAML rendering (handled in frontend)
- Prometheus connectivity test from the new paste UI (nice to have, not required)
