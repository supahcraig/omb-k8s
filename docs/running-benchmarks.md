# Running Benchmarks with omb-k8s

A practical guide for Solutions Engineers running customer engagements.

## Prerequisites

- omb-k8s deployed to a k8s cluster (EKS, GKE, or AKS) — see the deployment guide for your cloud
- VPC peering active between the omb-k8s cluster and the target Redpanda/Kafka cluster
- LoadBalancer address for the control plane UI (output from `helm install`)
- Seed broker address(es) and SASL credentials for the target cluster

---

## UI overview

The control plane is a React SPA. A sticky left sidebar handles all navigation:

```
┌─────────────────────┐
│  omb-k8s            │
├─────────────────────┤
│ Benchmark Runs      │
│   New Run           │
│   Sweeps            │
│   Workload Library  │
├─────────────────────┤
│ Infrastructure      │
│   OMB Cluster       │
│   Settings          │
├─────────────────────┤
│                     │
│ Workers: ● 3/3      │
│ [3] [Scale]         │
└─────────────────────┘
```

The **worker scaling control** at the bottom of the sidebar shows current worker
count and readiness. You adjust worker count here without redeploying.

---

## Section 1: Configuring cluster connectivity

Before running any benchmarks, tell omb-k8s how to reach the target cluster.

Go to **Settings** (sidebar, Infrastructure group) → **Cluster Connectivity** tab.

### BYOC (Redpanda Cloud)

Get the bootstrap server from the Redpanda Cloud console (Cluster Overview →
Bootstrap URL). Create a service account user with the ACLs your workload needs.

```
┌──────────────────────────────────────────────────┐
│ Cluster Connectivity                             │
│                                                  │
│ Seed Brokers                                     │
│ [seed-1234.abc.fmc.ppd.cloud.redpanda.com:9092] │
│                                                  │
│ [✓] Enable TLS                                   │
│ [✓] Enable SASL   Mechanism: SCRAM-SHA-256       │
│ Username: [your-sasl-username                  ] │
│ Password: [••••••••••••••••••••••••••••••••••••] │
└──────────────────────────────────────────────────┘
```

- **Seed Brokers:** paste the single bootstrap server, press Enter to add it as a chip
- **TLS:** enabled (always required for BYOC)
- **SASL:** enabled, mechanism SCRAM-SHA-256
- Fill in the service account username and password

### Self-hosted Redpanda or Kafka

Self-hosted clusters typically expose multiple seed brokers. Add each one
separately (type each address, press Enter):

```
┌────────────────────────────────────────┐
│ Cluster Connectivity                   │
│                                        │
│ Seed Brokers                           │
│ [10.0.1.10:9092] [10.0.1.11:9092]     │
│ [10.0.1.12:9092]                       │
│                                        │
│ [ ] Enable TLS                         │
│ [ ] Enable SASL                        │
└────────────────────────────────────────┘
```

Enable TLS and SASL only if your cluster is configured for them. When SASL is
enabled, choose the mechanism that matches your broker's `sasl.mechanism` setting.

Save settings before moving on. The seed brokers will pre-fill the Driver form
on the New Run page.

---

## Section 2: Scaling workers

Workers are the pods that actually generate and consume messages. More workers =
more aggregate throughput capacity.

Use the **worker scaling control** at the bottom of the sidebar:

```
Workers: ● 3/3   [3]  [Scale]
```

- The readiness badge shows `ready / desired` — wait until both numbers match
  before running a benchmark
- Type the desired replica count and click **Scale** — pods are added or removed
  non-destructively (no restart of existing pods)
- Each worker pod runs on its own node (m5.4xlarge on AWS, n2-standard-16 on GCP)
  with dedicated network interfaces — the Cluster Autoscaler provisions new nodes
  automatically when you scale up

**Rule of thumb:** start with the number of workers that gives you 2–4x your
target producer rate in available headroom. If worker CPU is saturated during a
run, add more workers rather than changing instance types.

Check worker pod health at any time on the **OMB Cluster** page (Infrastructure
group). Each pod row shows a health dot and a restart button.

---

## Section 3: Using the Workload Library

The Workload Library (**Benchmark Runs → Workload Library**) contains pre-bundled
workload configurations. These are good starting points for common scenarios.

```
┌─────────────────────────────────────────────────────────────┐
│ Workload Library                                            │
├──────────────────────────────┬────────────┬─────────────────┤
│ Name                         │ Msg Size   │ Actions         │
├──────────────────────────────┼────────────┼─────────────────┤
│ basic-1topic-100b-10prod     │ 100 B      │ [Use] [Clone]   │
│ throughput-1k-messages       │ 1024 B     │ [Use] [Clone]   │
│ latency-small-payload        │ 64 B       │ [Use] [Clone]   │
└──────────────────────────────┴────────────┴─────────────────┘
```

- **Use** — navigates to New Run with the workload pre-filled; you can adjust
  any field before launching
- **Clone** — copies the workload to a new entry you can rename and modify

You can also **create a workload from scratch** on the Workload Library page and
save it for reuse across multiple runs.

---

## Section 4: Running a single benchmark

Go to **Benchmark Runs → New Run**.

### New Run page layout

```
┌─────────────────────────────────────────────────────────┐
│  Run name: [customer-baseline-acks-all         ]        │
│  Projected load: 100 MB/s                   [Launch]    │
├──────────────────────────┬──────────────────────────────┤
│  Driver          (blue)  │  Workload         (green)    │
│  Bootstrap servers       │  messageSize: 1024           │
│  [10.0.1.10:9092]        │  producerRate: 100000        │
│  TLS [ ]  SASL [ ]       │  producers: 4                │
│  topicConfig:            │  consumers: 4                │
│  [                     ] │  subscriptions: 1            │
│  Topics: 1               │  sampleRateMillis: 1000      │
│  Partitions: 16          │  warmupDuration: 60          │
│                          │  testDuration: 300           │
├──────────────────────────┼──────────────────────────────┤
│  Driver YAML             │  Workload YAML               │
│  (read-only preview)     │  (read-only preview)         │
└──────────────────────────┴──────────────────────────────┘
```

### Driver form fields

| Field | Description |
|-------|-------------|
| Bootstrap servers | Pre-filled from Settings; override per-run if needed |
| TLS | Pre-filled from Settings |
| SASL / credentials | Pre-filled from Settings |
| topicConfig | Java Properties format: `key=value` one per line. Example: `retention.ms=600000`. Leave blank unless you need to override topic defaults. |
| Topics | Number of topics to create for the benchmark |
| Partitions | Partition count per topic |

> **topicConfig format note:** Use `key=value` (Java Properties), not `key: value`
> (YAML). Using YAML syntax here will cause the run to fail at startup.

### Workload form fields

| Field | Description |
|-------|-------------|
| messageSize | Payload size in bytes |
| producerRate | Target messages per second (aggregate across all producers) |
| producers | Number of producer threads |
| consumers | Number of consumer threads |
| subscriptions | Number of consumer subscriptions |
| sampleRateMillis | How often OMB logs a stats line (default: 1000 ms = 1/second). Increase for very long runs if log volume is a concern. |
| warmupDurationSeconds | Pre-benchmark warmup period — stats are not recorded during warmup |
| testDurationSeconds | How long the actual benchmark runs |

### Launching and monitoring

Click **Launch**. The page navigates immediately to the **Run Detail** page.

```
┌──────────────────────────────────────────────────────────┐
│ customer-baseline-acks-all          Status: ● warmup     │
├──────────────────────────────────────────────────────────┤
│ Live log                                                  │
│ > 2026-05-28T10:01:04Z Starting warm-up traffic...       │
│ > 2026-05-28T10:02:04Z Pub rate: 98234 msg/s...          │
│ ...                                                       │
├──────────────────────────────────────────────────────────┤
│  Throughput (MB/s)    │  Latency (ms)                    │
│  [chart]              │  [chart: p50/p99/p999]           │
├──────────────────────────────────────────────────────────┤
│  Worker CPU (%)       │  Worker Memory (GiB)             │
│  [chart: per-pod]     │  [chart: per-pod]                │
└──────────────────────────────────────────────────────────┘
```

**Status badge phases:**

| Badge | Meaning |
|-------|---------|
| `initializing` (purple) | JVM and worker setup in progress |
| `warmup` (blue) | Warmup traffic running; stats not recorded yet |
| `running` (green) | Benchmark traffic running; stats being recorded |
| `completed` | Run finished; final metrics available |
| `failed` | Run failed; check the live log for the error |

The live log panel streams OMB output in real time. Final aggregated metrics
(p50/p99/p999 latency, throughput, total messages) appear below the charts when
the run completes.

---

## Section 5: Running a parameter sweep

A parameter sweep runs the same benchmark multiple times, varying one or more
parameters across a defined set of values. Use sweeps to answer questions like:
"How does p99 latency change as producer rate increases from 100k to 1M msg/s?"

### Setting up a sweep

On the **New Run** page, enable the **Parameter Sweep** toggle at the top of the
page. The sweep section expands:

```
┌──────────────────────────────────────────────────────────────┐
│ [✓] Parameter Sweep                                          │
│ Cooldown between runs: [30] seconds                          │
├────────────────────────────────┬─────────────────────────────┤
│ Driver Axes                    │ Workload Axes               │
│ Field: [-- select --  ▼] [Add] │ Field: [producerRate ▼][Add]│
│                                │ Values:                     │
│                                │ [100000] [500000] [1000000] │
└────────────────────────────────┴─────────────────────────────┘
```

- **Cooldown:** seconds to wait between runs (allows brokers and workers to settle)
- **Driver Axes:** vary driver-side parameters (e.g., `acks`, `producerConfig.linger.ms`)
- **Workload Axes:** vary workload parameters (e.g., `producerRate`, `messageSize`)

Add values to an axis by typing a value and pressing Enter. Multiple axes produce
the Cartesian product of all value combinations.

### Monitoring sweep execution

After clicking Launch, you land on the first run's detail page. A sweep nav bar
appears above the page header:

```
┌─────────────────────────────────────────────────────────┐
│ ● run-1 (100k)  ○ run-2 (500k)  ○ run-3 (1M)           │
│ ↑ current                                               │
└─────────────────────────────────────────────────────────┘
```

- Pills are colored by status (running = green, pending = gray, completed = blue, failed = red)
- When the current run completes, the page auto-advances to the next run
- A cooldown countdown badge appears between runs

### Reviewing sweep results

When all runs are complete, go to **Benchmark Runs → Sweeps** and open the sweep.
The **Sweep Detail** page shows a comparison table:

```
┌──────────────┬──────────┬───────────┬───────────┬───────────┐
│ producerRate │ MB/s     │ p50 (ms)  │ p99 (ms)  │ p999 (ms) │
├──────────────┼──────────┼───────────┼───────────┼───────────┤
│ 100,000      │ 97.4     │ 2.1       │ 4.8       │ 12.3      │
│ 500,000      │ 489.2    │ 3.2       │ 9.1       │ 28.7      │
│ 1,000,000    │ 891.6    │ 8.4       │ 42.0      │ 145.2     │
└──────────────┴──────────┴───────────┴───────────┴───────────┘
```

Click any run row to open that run's detail page with full charts and logs.

---

## Section 6: Configuring Prometheus metrics

Prometheus is deployed with omb-k8s. When enabled, it collects worker CPU and
memory metrics every 15 seconds during runs — these power the per-pod charts on
the Run Detail page.

Go to **Settings → Prometheus** tab:

```
┌──────────────────────────────────────────────────────────┐
│ Prometheus                                               │
│                                                          │
│ [✓] Enable metric collection                             │
│                                                          │
│ In-cluster URL (pre-configured):                         │
│ http://omb-kube-prometheus-stack-prometheus.omb...       │
└──────────────────────────────────────────────────────────┘
```

Enable the toggle. The in-cluster Prometheus URL is pre-configured and does not
require manual entry.

When enabled, the Worker CPU and Worker Memory charts on the Run Detail page show
one line per pod (e.g., `worker-0`, `worker-1`, `worker-2`). This is useful for
spotting uneven load distribution across workers.

If Prometheus is unreachable, the collector silently no-ops — runs complete
normally but the per-pod charts will not have data.

---

## Section 7: Interpreting results

### Key metrics

| Metric | What it means |
|--------|---------------|
| **Throughput (MB/s)** | Actual data throughput: `msgs/s × messageSize ÷ 1,048,576` |
| **Publish rate (msg/s)** | Actual producer throughput; compare to your target rate |
| **p50 latency** | Median end-to-end latency. Most messages experience this. |
| **p99 latency** | 99th percentile latency. Key for SLA conversations. |
| **p999 latency** | 99.9th percentile. Worst-case tail; identifies outlier events. |

### What good looks like

- **p99 < 10 ms** for most Redpanda workloads under normal load
- **Publish rate within 5% of target** — if actual rate is much lower, something
  is constraining throughput (brokers, network, or worker capacity)
- **Worker CPU well below 100%** — if workers are CPU-saturated, add more workers
  (use the scaling control in the sidebar) rather than changing instance types

### Common failure patterns

**Run fails immediately (status goes straight to `failed`)**

Check the live log for the error. Most common causes:
- **Stuck worker pod:** Go to **OMB Cluster**, find the pod with a red health dot,
  and click the restart button. After the pod recovers, retry the run.
- **Bad seed broker address:** Verify the address in Settings → Cluster Connectivity
  is reachable from the omb-k8s cluster (check VPC peering is active).
- **TLS/SASL misconfiguration:** A wrong mechanism or wrong credentials causes an
  immediate authentication failure in the OMB log.

**Throughput much lower than expected**

1. Confirm seed brokers and TLS/SASL settings are correct
2. Verify VPC peering routes are active (run a `kubectl exec` into a worker pod and
   `curl` or `nc` the broker address on port 9092)
3. Check the broker side — the cluster may be under-provisioned for the target load

**High p999 latency (tail latency spikes)**

- **GC pressure:** check the Worker Memory chart — if memory climbs to the heap
  limit and drops sharply, GC pauses are likely. Add more workers to reduce per-pod
  load.
- **Broker-side pressure:** high partition count, under-replicated partitions, or
  I/O saturation on the broker nodes. Check Redpanda/Kafka metrics on the broker side.
- **Network saturation:** worker CPU normal but throughput is capped — you may be
  hitting node NIC bandwidth limits. Add more workers to spread load across more nodes.

**Publish rate saturates below target**

Add more workers. Each OMB worker pod handles a share of the producer and consumer
threads. If the current workers are CPU- or network-bound, the aggregate rate
plateaus regardless of the target rate setting. Scale up, wait for the readiness
badge to show all workers ready, then rerun.

---

## Section 8: Tips for common engagement scenarios

### Establishing a throughput ceiling

1. Start with 3 workers and a moderate `producerRate` (e.g., 200k msg/s)
2. Run a sweep on `producerRate` with values stepping up until throughput stops
   tracking the target rate (e.g., 200k, 400k, 800k, 1.2M)
3. The point where actual throughput diverges from target rate is the cluster ceiling
   at that message size and configuration

### Latency characterization

1. Set `producerRate` to a steady, sustainable load (well below ceiling)
2. Vary `messageSize` in a sweep (e.g., 100, 1024, 4096, 65536 bytes)
3. Compare p99 and p999 across message sizes — useful for showing latency impact
   of large payloads vs. small payloads

### Testing acks sensitivity

Set up a sweep on the driver parameter `acks` with values `0`, `1`, `all`.
This is a driver-side parameter — add it as a Driver Axis. The sweep shows the
throughput and latency tradeoff across acks settings.

> **Note:** `acks` is set in `producerConfig` in the driver YAML as Java Properties
> format: `acks=all`. When adding it as a sweep axis, use the field name
> `producerConfig.acks` in the Driver Axes panel.

### Warmup and test duration guidelines

| Run type | warmupDurationSeconds | testDurationSeconds |
|----------|-----------------------|---------------------|
| Quick sanity check | 30 | 60 |
| Standard benchmark | 60 | 300 |
| Sustained load test | 120 | 1800 |
| Long-running stability | 120 | 7200+ |

Increase `sampleRateMillis` (e.g., to 5000 or 10000) on runs longer than 30
minutes to keep log volume manageable. This does not affect the accuracy of final
aggregated metrics (p50/p99/etc.) — only the resolution of the live chart.

---

## Troubleshooting reference

| Symptom | Where to look | What to do |
|---------|---------------|------------|
| Worker health dot red | OMB Cluster page | Click restart; wait for pod to recover |
| Run fails with "worker returned 500" | Run Detail log | Restart the offending worker pod |
| PVC stuck in Pending | `kubectl -n omb get pvc` | Check StorageClass exists; EBS CSI addon required on EKS |
| Settings not persisting across pod restarts | PV mount | Verify PersistentVolume is bound: `kubectl -n omb get pv` |
| Charts show no Prometheus data | Run Detail | Enable Prometheus in Settings; check in-cluster URL |
| Sweep auto-advance not happening | Run Detail sweep nav | Check that all workers are healthy before launching |
