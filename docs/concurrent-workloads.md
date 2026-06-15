# Run Types: Single Runs, Sweeps, and Concurrent Workloads

A complete reference for the three ways to run benchmarks with omb-k8s.

---

## Overview

| Run type | What it does | When to use |
|----------|-------------|-------------|
| **Single run** | One benchmark, one parameter set | Baseline measurement, quick sanity check, targeted repro |
| **Parameter sweep** | Many runs in sequence, varying one or more parameters automatically | Answering "how does X change as Y varies?" across a range |
| **Concurrent workloads** | Multiple runs against the same cluster simultaneously | Mixed-workload characterization, background load + sweep, multi-tenant simulation |

All three types share the same run lifecycle — they produce the same metrics, use
the same Run Detail page, and appear on the Timeline. The differences are in
how they are configured and what happens after you click **Launch**.

---

## Single Runs

### When to use

Single runs are the starting point for any engagement. Use them to:

- Establish a baseline before varying parameters
- Reproduce a specific customer scenario with a known configuration
- Quickly verify that cluster connectivity is working
- Run a one-off test after adjusting broker configuration

### Launching a single run

1. Go to **Benchmark Runs → New Run**
2. Fill in the Driver form (broker address, TLS/SASL — pre-filled from Settings)
3. Fill in the Workload form (message size, producer rate, duration)
4. Optionally select a config from the library via **Browse library** in each panel header
5. Select a **Worker Pool** from the dropdown (auto-selected if only one ready pool exists)
6. Click **Launch** — the page navigates immediately to the Run Detail page

The form prefills from the most recent run on page load. To start from a saved
configuration, use the **Browse library** drawer in the Driver or Workload panel
header.

### The Run Detail page

```
┌──────────────────────────────────────────────────────────┐
│ customer-baseline-acks-all          Status: ● running    │
├──────────────────────────────────────────────────────────┤
│ Live log                                            [▼]  │
│ > 2026-05-28T10:02:04Z Pub rate: 98234 msg/s...          │
│ > 2026-05-28T10:02:05Z Pub rate: 99012 msg/s...          │
├──────────────────────────────────────────────────────────┤
│  Throughput (MB/s)    │  Throughput (msg/s)              │
│  [chart]              │  [chart: actual + target line]   │
├──────────────────────────────────────────────────────────┤
│  Backlog              │  Worker CPU (per-pod)            │
│  [chart]              │  [chart: worker-0, worker-1...]  │
├──────────────────────────────────────────────────────────┤
│  Worker Memory (GiB)  │  Worker Network Tx (MB/s)        │
│  [chart: per-pod]     │  [chart: per-pod, if available]  │
└──────────────────────────────────────────────────────────┘
```

**Status badge phases:**

| Badge | Meaning |
|-------|---------|
| `initializing` (purple) | JVM and worker setup; no traffic yet |
| `warmup` (blue) | Warmup traffic running; stats not recorded |
| `running` (green) | Benchmark traffic running; stats being recorded |
| `completed` | Run finished; final metrics displayed below |
| `failed` | Run failed; check the live log for the error |

**After completion**, the page switches to a finalized view:

- Throughput tiles showing actual vs target for publish and consume rates
- HDR percentile curves and nines table from the OMB output file
- Latency histograms (p50, p99, p999)
- RunCharts with throughput, backlog, and worker resource charts

The live log auto-collapses on completion. Click the twisty (`▶`/`▼`) to expand
it again for full log inspection.

---

## Parameter Sweeps

### When to use

Sweeps answer questions of the form "how does metric M change as parameter P varies
across values V1, V2, V3?" Common sweep scenarios:

- **Throughput ceiling:** sweep `producerRate` upward until actual throughput stops
  tracking the target — that's the cluster ceiling at this configuration
- **acks sensitivity:** sweep driver `acks` across `0`, `1`, `all` to show the
  throughput/durability tradeoff
- **Message size impact:** sweep `messageSize` to show how latency and throughput
  change with payload size
- **Multi-axis:** sweep both `producerRate` and `messageSize` simultaneously to
  produce a 2D characterization grid

### Axes: Driver vs Workload

The sweep section on the New Run page has two panels:

- **Driver Axes (left):** parameters that live in the driver YAML —
  `acks`, `producerConfig.linger.ms`, `producerConfig.batch.size`, etc.
- **Workload Axes (right):** parameters that live in the workload YAML —
  `producerRate`, `messageSize`, `producers`, `consumers`, etc.

Use the **Custom…** option in the field dropdown to enter any arbitrary parameter
path not in the fixed list.

### Cartesian product behavior

Multiple axes produce the full Cartesian product of their value lists:

```
Driver axis:    acks = [0, 1, all]          → 3 values
Workload axis:  producerRate = [100k, 500k] → 2 values

Total runs: 3 × 2 = 6

Run 1: acks=0,   producerRate=100k
Run 2: acks=0,   producerRate=500k
Run 3: acks=1,   producerRate=100k
Run 4: acks=1,   producerRate=500k
Run 5: acks=all, producerRate=100k
Run 6: acks=all, producerRate=500k
```

The projected run count and estimated total time appear in the header card before
you launch.

### Setting up a sweep

On the **New Run** page:

1. Enable the **Parameter Sweep** toggle at the top
2. Set the **Cooldown** (seconds between runs — allows brokers and workers to settle
   back to baseline; 30 s is a safe default for most workloads)
3. In the Driver Axes panel, select a field and add values using Enter
4. In the Workload Axes panel, repeat for workload parameters
5. Fill in Driver and Workload forms as usual (these become the base config; sweep
   values override specific fields)
6. Click **Launch**

```
┌────────────────────────────────────────────────────────────────┐
│ [✓] Parameter Sweep   Cooldown: [30] s     Total: ~36 min      │
├────────────────────────────────┬───────────────────────────────┤
│ Driver Axes                    │ Workload Axes                 │
│ Field: [acks            ▼][Add]│ Field: [producerRate  ▼][Add] │
│ Values: [0] [1] [all]          │ Values: [100000] [500000]     │
│                                │        [1000000]              │
│ Field: [-- select --  ▼][Add]  │ Field: [-- select --  ▼][Add] │
└────────────────────────────────┴───────────────────────────────┘
```

### Monitoring sweep execution

After clicking **Launch**, you land on the first run's detail page. A **sweep nav
bar** appears above the page header showing a pill for each run:

```
┌─────────────────────────────────────────────────────────────────┐
│ ● acks=0/100k  ○ acks=0/500k  ○ acks=1/100k  ○ acks=1/500k ... │
└─────────────────────────────────────────────────────────────────┘
```

- Running pill glows green; pending pill is gray; cooldown pill glows ice blue;
  failed pill is red
- When the current run finishes, the page auto-advances to the next run after
  the cooldown period
- A 🧊 countdown badge shows remaining cooldown time
- Click any pill to jump directly to that run's detail page

### Reviewing sweep results

**Sweeps list** (`/sweeps`): each row shows the sweep name, status, run count,
and best publish P99 and end-to-end P99 across all runs — a quick pass/fail
indicator before opening the sweep.

**Sweep Detail page** (`/sweeps/:id`): click any sweep in the list to open the
comparison table. The table has a sticky two-row header — the top row groups
sweep parameter columns under a "Sweep Parameters" superheading:

```
┌────┬──────┬──────────────────────────┬──────────┬────────┬────────┐
│    │      │    Sweep Parameters      │          │        │        │
│ ☐  │ Run  │ acks  │ producerRate     │  MB/s    │ p99    │ p999   │
├────┼──────┼───────┼──────────────────┼──────────┼────────┼────────┤
│ ☐  │  1   │  0    │ 100,000          │  97.4    │  2.1   │  5.3   │
│ ☐  │  2   │  0    │ 500,000          │ 489.2    │  3.8   │  9.1   │
│ ☐  │  3   │  1    │ 100,000          │  96.8    │  4.8   │ 12.3   │
│ ☐  │  4   │  1    │ 500,000          │ 484.1    │  9.1   │ 28.7   │
└────┴──────┴───────┴──────────────────┴──────────┴────────┴────────┘
```

Click any row to open that run's detail page. Sort by any column header.

### Sweep visualizations

Select runs with the checkboxes (up to 10 at a time). Two chart types appear:

**Percentile curves** — one line per selected run, x-axis is percentile on a
nines scale (p50 through p99.99), y-axis is latency in ms. Good for comparing
tail latency behavior across parameter values — diverging lines at high percentiles
show which configurations produce worse tail behavior.

**Heatmap** — each column is a selected run, each row is a percentile bucket.
Color intensity maps to latency. Good for spotting which runs have uniformly low
latency vs. which have high tail values at a glance.

The **Select all** checkbox selects the 10 best-performing runs by publish P99.

### Tips for effective sweeps

- **Start sparse, then refine.** A 3-value sweep across a wide range (e.g., 100k,
  500k, 1M msg/s) is faster than a 10-value sweep. Once you find the interesting
  region, create a follow-up sweep with finer granularity.
- **Cooldown guidelines:** 30 s is enough for most workloads. Increase to 60–120 s
  if broker metrics (partition leadership, ISR) take longer to stabilize.
- **Keep one axis at a time for causal clarity.** Multi-axis sweeps are powerful but
  make it harder to attribute differences to a single variable.
- **sampleRateMillis and sweep duration:** the default 1 s sample rate generates one
  log line per second. For long sweeps (5+ runs × 5+ min each), increase
  `sampleRateMillis` in the workload form to 5000 to keep log volume manageable.

---

## Concurrent Workloads

### When to use

Run workloads concurrently when you need to characterize how different types of
traffic interact on the same cluster:

- **Mixed-workload interference:** does running a high-throughput bulk producer
  degrade p99 latency for a separate latency-sensitive workload?
- **Background load + sweep:** pin a sustained background workload on pool A
  while sweeping parameters on pool B — the sweep results reflect the cluster
  under realistic mixed load
- **Multi-tenant simulation:** reproduce a production environment with multiple
  independent applications sharing the same cluster
- **Before/after comparison:** run a baseline on pool A while a configuration
  change takes effect, then launch the same workload on pool B to compare results
  from the same time window

### Worker pools

Every run requires a **worker pool** — a StatefulSet of OMB worker pods that
execute the benchmark traffic. There is always exactly one default pool
(`omb-worker`), which is pre-created by the Helm chart and never deleted.

For concurrent runs you need one pool per simultaneous run. Pools are created and
managed manually from the **OMB Cluster** page.

**Pool lifecycle:**

```
  [Create on Cluster page]
           │
           ▼
      provisioning   ← Cluster Autoscaler adding nodes
           │
           ▼
         ready       ← available to claim
           │
    [SE launches run]
           │
           ▼
        in_use       ← run is running
           │
    [run completes or is cancelled]
           │
           ▼
         ready       ← available again
           │
    [SE deletes from Cluster page]
           │
           ▼
       (deleted)
```

The **default pool** never enters `deleted` state. Non-default pools persist until
you explicitly delete them from the Cluster page.

### Step-by-step: running two workloads simultaneously

**1. Verify the default pool is ready**

Open **OMB Cluster** and confirm the `default` pool shows `ready` with the correct
replica count. If workers are not ready, wait or use the sidebar scaling control.

**2. Create a second pool**

On the **OMB Cluster** page, fill in the **Create Worker Pool** form:

```
┌─────────────────────────────────────────────────────┐
│ Create Worker Pool                                   │
│                                                      │
│ Pool name:  [pool-b                               ]  │
│ Replicas:   [3]                                      │
│                                              [Create] │
└─────────────────────────────────────────────────────┘
```

Wait for `pool-b` to show `ready` in the Worker Pools table. On a cold AWS node
this takes 5–10 minutes. You can proceed with launching the first run while the
second pool provisions — it just won't be available until ready.

**3. Launch the first run**

Go to **New Run**, configure the first workload, select `default` from the
**Worker Pool** dropdown, and click **Launch**. The page navigates to the run
detail immediately.

**4. Launch the second run**

Open a new tab (or navigate back to **New Run**), configure the second workload,
select `pool-b` from the **Worker Pool** dropdown, and click **Launch**.

Both runs are now active simultaneously. The `default` pool and `pool-b` each show
`in_use` on the Cluster page.

**5. Monitor on the Timeline**

Go to **Benchmark Runs → Timeline** to see both runs side by side as a Gantt chart:

```
Timeline (last 1 hour)

run-23  [████████████████████████████████] throughput-1M-acks-0
run-24      [████████████████████████████] latency-100k-acks-all
              ↑ launched 4 min later
```

Bars are colored by phase (gray = initializing, blue = warmup, green = benchmark).
Click any bar to open that run's detail page in the current tab.

### The Worker Pool dropdown on New Run

The **Worker Pool** dropdown shows all `ready` pools. Behavior:

- If exactly one pool is ready, it is auto-selected
- If multiple pools are ready, you must choose explicitly
- If no pool is ready, the Launch button is disabled with the message:
  "No worker pools are available. Create one on the Cluster page before launching a run."

### Managing pools on the Cluster page

```
┌──────────────────────────────────────────────────────────────────────────┐
│ Worker Pools                                                              │
├───────────────┬────────────────┬──────────┬────────────┬─────────────────┤
│ Pool          │ StatefulSet    │ Replicas │ Status     │ Claimed By      │
├───────────────┼────────────────┼──────────┼────────────┼─────────────────┤
│ default       │ omb-worker     │ 3/3      │ ready      │ —               │
│ pool-b        │ omb-worker-... │ 3/3      │ in_use     │ run-24          │
└───────────────┴────────────────┴──────────┴────────────┴─────────────────┘
                                                          [Scale] [Delete]
```

- **Scale** — available when pool is `ready`; changes the replica count on the
  StatefulSet. Use this to add or remove workers from a pool between runs.
- **Delete** — available on non-default pools when `ready`; tears down the
  StatefulSet and Service.
- The **Claimed By** column links to the active run when a pool is `in_use`.

### Cancelling a concurrent run

Cancel from the Run Detail page (using the Cancel button in the run header).
The k8s Job and ConfigMap are cleaned up immediately. The pool returns to `ready`
status right away — you can then either launch another run against it or delete
it from the Cluster page.

### Common patterns

**Pattern A: Background load + targeted sweep**

```
Pool A (default, 3 workers):
  Run a sustained 200k msg/s workload for the full engagement session.
  This stays in_use the entire time — don't use default for the sweep.

Pool B (pool-b, 3 workers):
  Run a sweep on producerRate: 500k, 1M, 2M msg/s.
  Each sweep run claims pool-b, runs to completion, returns it to ready,
  then the next sweep run claims it again.
```

Sweep results measured under realistic background load give more accurate ceiling
numbers for production planning than isolated benchmarks.

**Pattern B: Side-by-side configuration comparison**

```
Pool A (default, 3 workers):
  Run throughput-acks-1 — acks=1, producerRate=500k

Pool B (pool-b, 3 workers):
  Run throughput-acks-all — acks=all, producerRate=500k (launched simultaneously)
```

Both runs are active over the same time window on the same cluster. Timeline shows
them overlapping. Compare run detail pages directly: if acks=all adds 4 ms to p99
but only reduces throughput by 2%, that's a useful data point for the customer.

**Pattern C: Worker scaling experiment**

```
Pool A (default, 2 workers):  run at target rate
Pool B (pool-b, 4 workers):   run at same target rate simultaneously
```

Same workload config, different worker counts. Compare worker CPU and memory
charts across the two run detail pages to understand per-worker load distribution.

---

## Comparing results across run types

### Single run results

Open the run from **Benchmark Runs** (the main list). The Run Detail page shows:

- Finalized throughput tiles (actual vs target, with color coding: green ≥ 95%,
  red < 95%)
- HDR percentile curves and nines table
- Throughput, backlog, and per-pod worker resource charts

### Sweep comparison

Open the sweep from **Benchmark Runs → Sweeps**. The Sweep Detail page shows:

- Sortable comparison table with all runs and their sweep parameter values
- Checkbox-driven percentile curve overlay (up to 10 runs)
- Heatmap showing latency intensity across runs and percentile buckets

Use the table sort to quickly find which parameter combination produced the
best p99 or highest throughput. Click any row to drill into that run's full detail.

### Concurrent run comparison

There is no dedicated comparison UI for concurrent runs — use these two surfaces:

1. **Timeline** (`/timeline`): Gantt view confirms runs overlapped and shows
   relative duration and phase timing. Click any bar to open its run detail.

2. **Individual Run Detail pages**: open both runs in separate browser tabs.
   Charts are time-aligned to the same real-world timestamps (all chart x-axes
   show local time), so you can visually compare throughput curves, latency, and
   worker resource usage across the two runs at the same moment in time.

For a quick numerical comparison, the **Benchmark Runs** list (`/`) shows both
runs with their final throughput and p99 latency values side by side.
