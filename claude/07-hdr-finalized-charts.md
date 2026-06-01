# HDR Finalized Charts — Post-Run Results Presentation

Read CLAUDE.md and claude/ui-guidance.md fully before doing anything else.
Read the existing results page code carefully before changing anything.

This session has two parts: backend parsing of the OMB JSON results file,
and frontend presentation of finalized post-run charts. Do not touch
Terraform, Helm, or CI/CD.

---

## Context — the results JSON file

OMB writes a results file to the PersistentVolume at the end of each run.
The filename pattern is:
- Single run: run-<run-id>.json
- Sweep run: sweep-<sweep-id>-run-<run-id>.json

The PV is mounted at /data in the control plane pod. Results files live
at /data/results/.

The JSON structure contains (all latency values in milliseconds):

**Per-second time series arrays (one value per sampleRateMillis interval):**
- sent, consumed — message counts per interval
- publishRate, consumeRate — msg/s per interval
- backlog — message lag per interval
- publishLatencyMin, publishLatencyAvg, publishLatency50pct,
  publishLatency75pct, publishLatency95pct, publishLatency99pct,
  publishLatency999pct, publishLatency9999pct, publishLatencyMax
- endToEndLatencyMin, endToEndLatencyAvg, endToEndLatency50pct,
  endToEndLatency75pct, endToEndLatency95pct, endToEndLatency99pct,
  endToEndLatency999pct, endToEndLatency9999pct, endToEndLatencyMax
- scheduleLatencyMin, scheduleLatency50pct, scheduleLatency75pct,
  scheduleLatency99pct, scheduleLatencyMax

**Aggregated values (entire run):**
- aggregatedPublishLatencyAvg, aggregatedPublishLatency50pct,
  aggregatedPublishLatency75pct, aggregatedPublishLatency95pct,
  aggregatedPublishLatency99pct, aggregatedPublishLatency999pct,
  aggregatedPublishLatency9999pct, aggregatedPublishLatencyMax
- aggregatedEndToEndLatencyAvg, aggregatedEndToEndLatency50pct,
  aggregatedEndToEndLatency75pct, aggregatedEndToEndLatency95pct,
  aggregatedEndToEndLatency99pct, aggregatedEndToEndLatency999pct,
  aggregatedEndToEndLatency9999pct, aggregatedEndToEndLatencyMax

**HDR percentile curve data (dict of percentile_string → latency_ms):**
- aggregatedPublishLatencyQuantiles
- aggregatedEndToEndLatencyQuantiles

Keys are percentile values as float strings (e.g. "99.99002907355968"),
values are latency in ms. These have thousands of entries — thin to every
10th point for chart rendering. No HDR library needed — OMB has already
decoded the histogram. Only include percentiles >= 50.0.

**Run metadata:**
- beginTime, endTime, messageSize, topics, partitions,
  producersPerTopic, consumersPerTopic, sampleRateMillis, driver

---

## Backend changes

### New API endpoint

GET /api/runs/{run_id}/results

Reads the results JSON file from /data/results/run-{run_id}.json,
parses it, and returns a structured response:

```json
{
  "metadata": {
    "beginTime": "...",
    "endTime": "...",
    "messageSize": 1024,
    "topics": 1,
    "partitions": 32,
    "producersPerTopic": 4,
    "consumersPerTopic": 1,
    "driver": "Redpanda"
  },
  "aggregates": {
    "publish": {
      "avg": 3.5,
      "p50": 3.3, "p75": 4.1, "p95": 5.6,
      "p99": 8.2, "p999": 15.4, "p9999": 22.1, "max": 33.9
    },
    "endToEnd": {
      "avg": 4.2,
      "p50": 3.9, "p75": 4.7, "p95": 6.5,
      "p99": 9.4, "p999": 23.6, "p9999": 28.9, "max": 33.9
    }
  },
  "percentileCurves": {
    "publish": [{"percentile": 50.0, "latencyMs": 3.3}, ...],
    "endToEnd": [{"percentile": 50.0, "latencyMs": 3.9}, ...]
  },
  "timeSeries": {
    "publishRate": [...],
    "consumeRate": [...],
    "backlog": [...],
    "publishLatencyP99": [...],
    "publishLatencyP999": [...],
    "endToEndLatencyP99": [...],
    "endToEndLatencyP999": [...]
  }
}
```

For percentileCurves: parse the aggregatedPublishLatencyQuantiles dict,
sort by float(key), thin to every 10th entry, return as array of
{percentile, latencyMs} objects. Only include percentiles >= 50.0.

If the results file does not exist yet, return 404. The frontend polls
this endpoint after run completion.

### Store parsed aggregates in SQLite

When the results file is parsed, store the aggregated values in a new
run_results table:

```sql
CREATE TABLE run_results (
  run_id TEXT PRIMARY KEY,
  publish_p50 REAL, publish_p75 REAL, publish_p95 REAL,
  publish_p99 REAL, publish_p999 REAL, publish_p9999 REAL,
  publish_max REAL, publish_avg REAL,
  e2e_p50 REAL, e2e_p75 REAL, e2e_p95 REAL,
  e2e_p99 REAL, e2e_p999 REAL, e2e_p9999 REAL,
  e2e_max REAL, e2e_avg REAL,
  publish_quantiles_json TEXT,
  e2e_quantiles_json TEXT,
  parsed_at DATETIME
)
```

### Trigger parsing on Job completion

When the control plane detects a Job has completed (already watching via
k8s API), immediately call the results parsing logic. If the file is not
present yet, retry up to 5 times with 2-second delays before logging a
warning and giving up.

---

## Frontend changes

Do NOT modify or remove any existing Recharts components. All existing
charts must continue to work exactly as they do today.

### Charting libraries

The existing charts use Recharts and stay on Recharts — do not touch them.

For the new finalized charts, implement each chart type TWICE:
1. A Recharts version
2. A Plotly version (using the plotly package already available)

Place each pair side by side with a clear label above each:
"Recharts" on the left, "Plotly" on the right. This allows direct visual
comparison of the two libraries rendering the same data. The goal is to
inform a future decision about which library to standardize on — do not
make that decision in this session.

Both implementations must use the same underlying data from the API.
Both must respect the dark theme of the existing page.

### Results page — post-run state

When a run completes, the results page transitions to finalized view.
Triggered when run status changes to completed in existing status polling.

**What collapses:**
The live streaming charts collapse behind a disclosure element labeled
"Raw time series data ▶". Collapsed by default after run completion.
SE can expand to review live data.

**What is removed:**
The latency percentile tiles (min/mean/max table). Superseded by the
richer HDR-derived data below.

**What remains visible:**
Throughput summary tiles — actual avg publish rate vs target, actual avg
consume rate. Shows whether throttling occurred.

**New finalized charts:**

#### 1. The nines table

Not a chart — a clean summary table. No Recharts/Plotly needed.
Two columns: publish latency and e2e latency.
Rows: avg, p50, p75, p95, p99, p99.9, p99.99, max.
Values in ms, 3 decimal places.
Color coding: p99 > 10ms = amber, p99 > 20ms = red. Visual guidance only,
does not block any actions.
This is the first thing an SE shows a customer — make it prominent.

#### 2. Percentile curve (publish latency)

Both Recharts and Plotly versions side by side.

Spec for both:
- x-axis: percentile, log scale, range p50 to p99.9999
- y-axis: latency in ms, linear scale
- Single line from aggregatedPublishLatencyQuantiles (thinned)
- x-axis tick labels at: 50, 90, 99, 99.9, 99.99, 99.999
- Title: "Publish latency percentile curve"

#### 3. Percentile curve (e2e latency)

Same as above from aggregatedEndToEndLatencyQuantiles.
Title: "End-to-end latency percentile curve"

Place publish and e2e pairs in a 2x2 grid:
- Top left: publish Recharts | Top right: publish Plotly
- Bottom left: e2e Recharts  | Bottom right: e2e Plotly

#### 4. Latency histogram (publish)

Both versions side by side.

Spec for both:
- Bucket aggregatedPublishLatencyQuantiles into ~30 equal-width buckets
- x-axis: latency bucket (ms)
- y-axis: percentage of messages in each bucket
- Title: "Publish latency histogram"

#### 5. Latency histogram (e2e)

Same for e2e latency.
Title: "End-to-end latency histogram"

Same 2x2 grid layout as the percentile curves.

---

## Page layout after run completion

Top: throughput summary tiles (actual vs target)

Section: "Results summary"
- Nines table (full width)

Section: "Latency distribution — percentile curves"
- 2x2 grid: publish Recharts | publish Plotly / e2e Recharts | e2e Plotly
- Small label above each: "Recharts" / "Plotly"

Section: "Latency distribution — histograms"
- 2x2 grid: same pattern

Disclosure: "Raw time series data ▶" (collapsed by default)
- All existing live charts, completely unchanged

---

## Validation

1. Complete a benchmark run
2. Verify results file appears at /data/results/run-{id}.json
3. GET /api/runs/{id}/results returns correct structured data
4. Nines table renders with correct values, color coding works
5. All four percentile curve charts render (2 Recharts + 2 Plotly)
6. Log scale x-axis works correctly on percentile curves in both libraries
7. All four histogram charts render (2 Recharts + 2 Plotly)
8. Live charts are collapsed behind disclosure, expandable
9. Throughput tiles remain visible
10. All existing charts are completely unchanged

---

## Notes

- Do not implement schedule latency charts in this session
- Do not implement sweep comparison charts in this session
- Do not make the Recharts vs Plotly decision in this session —
  that decision comes after seeing both render in production
- The log scale on the percentile curve x-axis is non-negotiable —
  linear scale makes the tail behavior unreadable
- Threshold colors in the nines table are hardcoded for now
