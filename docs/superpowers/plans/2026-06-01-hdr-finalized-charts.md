# HDR Finalized Charts Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a finalized post-run view to RunDetailPage that renders HDR percentile curves and latency histograms (both Recharts and Plotly) from OMB result files, powered by a new `GET /api/runs/{id}/results` backend endpoint.

**Architecture:** Backend parses OMB JSON result files into a structured response (aggregates + percentile curves + histograms + time series) and stores aggregates in a new `run_results` SQLite table. Frontend fetches this after run completion and renders a new `FinalizedCharts` component; existing live charts collapse behind a `<details>` disclosure.

**Tech Stack:** Python/FastAPI/SQLAlchemy (backend), React 18 + Recharts + Plotly.js (frontend), SQLite via aiosqlite

---

## File Map

**Created:**
- `control-plane/services/hdr_result_parser.py` — file-finding, HDR parsing, DB storage, histogram computation
- `control-plane/tests/test_hdr_result_parser.py` — unit tests for parser
- `control-plane/frontend/src/components/FinalizedCharts.jsx` — NinesTable + percentile curves + histograms (Recharts + Plotly)

**Modified:**
- `control-plane/models.py` — add `RunResult` model
- `control-plane/database.py` — no change needed (create_all handles new tables)
- `control-plane/routers/runs.py` — add `GET /{run_id}/results` endpoint; trigger HDR parse from `_finish_run`
- `control-plane/frontend/src/api.js` — add `getRunResults`
- `control-plane/frontend/src/pages/RunDetailPage.jsx` — integrate finalized view, collapse live charts
- `control-plane/frontend/package.json` — add plotly deps

---

## Task 1: Add RunResult model to models.py

**Files:**
- Modify: `control-plane/models.py`

- [ ] **Step 1: Add the RunResult class to models.py**

Append to the bottom of `control-plane/models.py`:

```python
class RunResult(Base):
    __tablename__ = "run_results"

    run_id = Column(Integer, primary_key=True)
    publish_p50    = Column(Float, nullable=True)
    publish_p75    = Column(Float, nullable=True)
    publish_p95    = Column(Float, nullable=True)
    publish_p99    = Column(Float, nullable=True)
    publish_p999   = Column(Float, nullable=True)
    publish_p9999  = Column(Float, nullable=True)
    publish_max    = Column(Float, nullable=True)
    publish_avg    = Column(Float, nullable=True)
    e2e_p50        = Column(Float, nullable=True)
    e2e_p75        = Column(Float, nullable=True)
    e2e_p95        = Column(Float, nullable=True)
    e2e_p99        = Column(Float, nullable=True)
    e2e_p999       = Column(Float, nullable=True)
    e2e_p9999      = Column(Float, nullable=True)
    e2e_max        = Column(Float, nullable=True)
    e2e_avg        = Column(Float, nullable=True)
    publish_quantiles_json = Column(Text, nullable=True)  # JSON [{percentile, latencyMs}]
    e2e_quantiles_json     = Column(Text, nullable=True)
    parsed_at = Column(DateTime, default=datetime.utcnow)
```

Note: `create_all` in `init_db` creates new tables automatically; no ALTER TABLE needed.

- [ ] **Step 2: Verify the import of DateTime is already present at the top of models.py**

`models.py` already imports `DateTime` from sqlalchemy and `datetime` from datetime — confirm both are present. The new model uses `Column(DateTime, ...)` and `datetime.utcnow` like the existing `Run` and `Sweep` models.

- [ ] **Step 3: Commit**

```bash
cd /Users/cnelson/sandbox/omb_k8s/aws_private/omb-k8s
git add control-plane/models.py
git commit -m "feat: add RunResult model for HDR percentile storage"
```

---

## Task 2: Create hdr_result_parser service

**Files:**
- Create: `control-plane/services/hdr_result_parser.py`
- Create: `control-plane/tests/test_hdr_result_parser.py`

- [ ] **Step 1: Write the failing tests**

Create `control-plane/tests/test_hdr_result_parser.py`:

```python
import json
import os
import tempfile

import pytest

from services.hdr_result_parser import (
    _build_histogram,
    _find_result_file,
    _thin_quantiles,
    parse_hdr_results_from_file,
)


def _make_result_file(path: str, extra: dict = None):
    data = {
        "publishRate": [10000.0, 10100.0],
        "consumeRate": [10000.0, 10100.0],
        "backlog": [0.0, 0.0],
        "publishLatency99pct": [8.2, 8.3],
        "publishLatency999pct": [15.0, 15.1],
        "endToEndLatency99pct": [9.1, 9.2],
        "endToEndLatency999pct": [18.0, 18.1],
        "aggregatedPublishLatencyAvg": 3.5,
        "aggregatedPublishLatency50pct": 3.3,
        "aggregatedPublishLatency75pct": 4.1,
        "aggregatedPublishLatency95pct": 5.6,
        "aggregatedPublishLatency99pct": 8.2,
        "aggregatedPublishLatency999pct": 15.4,
        "aggregatedPublishLatency9999pct": 22.1,
        "aggregatedPublishLatencyMax": 33.9,
        "aggregatedEndToEndLatencyAvg": 4.2,
        "aggregatedEndToEndLatency50pct": 3.9,
        "aggregatedEndToEndLatency75pct": 4.7,
        "aggregatedEndToEndLatency95pct": 6.5,
        "aggregatedEndToEndLatency99pct": 9.4,
        "aggregatedEndToEndLatency999pct": 23.6,
        "aggregatedEndToEndLatency9999pct": 28.9,
        "aggregatedEndToEndLatencyMax": 33.9,
        "aggregatedPublishLatencyQuantiles": {
            str(50.0 + i * 0.5): 3.0 + i * 0.05
            for i in range(100)
        },
        "aggregatedEndToEndLatencyQuantiles": {
            str(50.0 + i * 0.5): 3.5 + i * 0.06
            for i in range(100)
        },
        "beginTime": "2024-01-01T00:00:00",
        "endTime": "2024-01-01T00:05:00",
        "messageSize": 1024,
        "topics": 1,
        "partitions": 32,
        "producersPerTopic": 4,
        "consumersPerTopic": 1,
        "driver": "Redpanda",
    }
    if extra:
        data.update(extra)
    with open(path, "w") as f:
        json.dump(data, f)


def test_thin_quantiles_filters_below_50():
    quantiles = {"40.0": 2.0, "50.0": 3.0, "90.0": 5.0, "99.0": 8.0}
    result = _thin_quantiles(quantiles)
    percentiles = [p["percentile"] for p in result]
    assert 40.0 not in percentiles
    assert 50.0 in percentiles


def test_thin_quantiles_sorted():
    quantiles = {"99.0": 8.0, "50.0": 3.0, "75.0": 5.0}
    result = _thin_quantiles(quantiles)
    pcts = [p["percentile"] for p in result]
    assert pcts == sorted(pcts)


def test_thin_quantiles_every_10th():
    quantiles = {str(50.0 + i): float(i) for i in range(50)}
    result = _thin_quantiles(quantiles, step=10)
    assert len(result) == 5  # indices 0, 10, 20, 30, 40


def test_build_histogram_returns_30_buckets():
    pairs = [{"percentile": 50.0 + i, "latencyMs": float(i)} for i in range(50)]
    result = _build_histogram(pairs)
    assert len(result) == 30


def test_build_histogram_percentages_sum_to_100():
    pairs = [{"percentile": 50.0 + i, "latencyMs": float(i)} for i in range(100)]
    result = _build_histogram(pairs)
    total = sum(b["percentage"] for b in result)
    assert abs(total - 100.0) < 1.0  # allow rounding error


def test_parse_hdr_results_from_file_returns_all_sections():
    with tempfile.NamedTemporaryFile(mode="w", suffix=".json", delete=False) as f:
        path = f.name
    try:
        _make_result_file(path)
        result = parse_hdr_results_from_file(path)
        assert result is not None
        assert "metadata" in result
        assert "aggregates" in result
        assert "percentileCurves" in result
        assert "histograms" in result
        assert "timeSeries" in result
        assert result["aggregates"]["publish"]["p99"] == 8.2
        assert result["aggregates"]["endToEnd"]["p99"] == 9.4
        assert len(result["percentileCurves"]["publish"]) > 0
        assert len(result["histograms"]["publish"]) == 30
    finally:
        os.unlink(path)


def test_parse_hdr_results_from_file_returns_none_for_invalid():
    with tempfile.NamedTemporaryFile(mode="w", suffix=".json", delete=False) as f:
        path = f.name
        json.dump({"not_a_result": True}, f)
    try:
        result = parse_hdr_results_from_file(path)
        assert result is None
    finally:
        os.unlink(path)


def test_find_result_file_matches_single_run(tmp_path):
    # Monkeypatch RESULTS_DIR
    import services.hdr_result_parser as mod
    original = mod.RESULTS_DIR
    mod.RESULTS_DIR = str(tmp_path)
    try:
        result_file = tmp_path / "run-42.json"
        result_file.write_text("{}")
        found = _find_result_file(42)
        assert found == str(result_file)
    finally:
        mod.RESULTS_DIR = original


def test_find_result_file_matches_sweep_run(tmp_path):
    import services.hdr_result_parser as mod
    original = mod.RESULTS_DIR
    mod.RESULTS_DIR = str(tmp_path)
    try:
        result_file = tmp_path / "sweep-5-run-42.json"
        result_file.write_text("{}")
        found = _find_result_file(42)
        assert found == str(result_file)
    finally:
        mod.RESULTS_DIR = original


def test_find_result_file_returns_none_when_missing(tmp_path):
    import services.hdr_result_parser as mod
    original = mod.RESULTS_DIR
    mod.RESULTS_DIR = str(tmp_path)
    try:
        found = _find_result_file(99)
        assert found is None
    finally:
        mod.RESULTS_DIR = original
```

- [ ] **Step 2: Run tests to confirm they all fail**

```bash
cd /Users/cnelson/sandbox/omb_k8s/aws_private/omb-k8s/control-plane
python -m pytest tests/test_hdr_result_parser.py -v 2>&1 | head -30
```

Expected: ImportError or ModuleNotFoundError for `services.hdr_result_parser`.

- [ ] **Step 3: Create services/hdr_result_parser.py**

```python
"""
Parse OMB HDR result files and store aggregated percentile data to the DB.
"""
import asyncio
import glob
import json
import logging
import os
from datetime import datetime
from typing import Optional

logger = logging.getLogger(__name__)

RESULTS_DIR = "/data/results"


def _find_result_file(run_id: int) -> Optional[str]:
    """Return path to the result file for run_id, checking both naming patterns."""
    for pattern in (
        f"{RESULTS_DIR}/run-{run_id}.json",
        f"{RESULTS_DIR}/sweep-*-run-{run_id}.json",
    ):
        matches = glob.glob(pattern)
        if matches:
            return matches[0]
    return None


def _thin_quantiles(
    quantiles: dict, min_pct: float = 50.0, step: int = 10
) -> list[dict]:
    """
    Filter to >= min_pct, sort by percentile, return every step-th entry.
    Returns [{percentile: float, latencyMs: float}].
    """
    pairs = []
    for k, v in quantiles.items():
        try:
            pct = float(k)
        except ValueError:
            continue
        if pct >= min_pct:
            pairs.append((pct, float(v)))
    pairs.sort(key=lambda x: x[0])
    return [{"percentile": pct, "latencyMs": ms} for pct, ms in pairs[::step]]


def _build_histogram(curve: list[dict], num_buckets: int = 30) -> list[dict]:
    """
    Build equal-width latency histogram from thinned curve data.
    Each point is treated as one sample; buckets count how many points fall in each range.
    Returns [{bucketLabel: str, percentage: float}].
    """
    if not curve:
        return []
    values = [p["latencyMs"] for p in curve]
    lo, hi = min(values), max(values)
    if lo == hi:
        return [{"bucketLabel": f"{lo:.2f}", "percentage": 100.0}]
    width = (hi - lo) / num_buckets
    counts = [0] * num_buckets
    for v in values:
        idx = min(int((v - lo) / width), num_buckets - 1)
        counts[idx] += 1
    total = len(values)
    return [
        {
            "bucketLabel": f"{lo + i * width:.2f}",
            "percentage": round(c / total * 100, 3),
        }
        for i, c in enumerate(counts)
    ]


def parse_hdr_results_from_file(path: str) -> Optional[dict]:
    """
    Read the OMB result JSON file and return the structured API response dict.
    Returns None if the file is missing, unreadable, or not an OMB result.
    """
    try:
        with open(path) as f:
            data = json.load(f)
    except Exception as exc:
        logger.warning("Failed to read result file %s: %s", path, exc)
        return None

    if "publishRate" not in data:
        return None

    pub_q_raw = data.get("aggregatedPublishLatencyQuantiles") or {}
    e2e_q_raw = data.get("aggregatedEndToEndLatencyQuantiles") or {}
    pub_curve = _thin_quantiles(pub_q_raw)
    e2e_curve = _thin_quantiles(e2e_q_raw)

    return {
        "metadata": {
            "beginTime":         data.get("beginTime"),
            "endTime":           data.get("endTime"),
            "messageSize":       data.get("messageSize"),
            "topics":            data.get("topics"),
            "partitions":        data.get("partitions"),
            "producersPerTopic": data.get("producersPerTopic"),
            "consumersPerTopic": data.get("consumersPerTopic"),
            "driver":            data.get("driver"),
        },
        "aggregates": {
            "publish": {
                "avg":   data.get("aggregatedPublishLatencyAvg"),
                "p50":   data.get("aggregatedPublishLatency50pct"),
                "p75":   data.get("aggregatedPublishLatency75pct"),
                "p95":   data.get("aggregatedPublishLatency95pct"),
                "p99":   data.get("aggregatedPublishLatency99pct"),
                "p999":  data.get("aggregatedPublishLatency999pct"),
                "p9999": data.get("aggregatedPublishLatency9999pct"),
                "max":   data.get("aggregatedPublishLatencyMax"),
            },
            "endToEnd": {
                "avg":   data.get("aggregatedEndToEndLatencyAvg"),
                "p50":   data.get("aggregatedEndToEndLatency50pct"),
                "p75":   data.get("aggregatedEndToEndLatency75pct"),
                "p95":   data.get("aggregatedEndToEndLatency95pct"),
                "p99":   data.get("aggregatedEndToEndLatency99pct"),
                "p999":  data.get("aggregatedEndToEndLatency999pct"),
                "p9999": data.get("aggregatedEndToEndLatency9999pct"),
                "max":   data.get("aggregatedEndToEndLatencyMax"),
            },
        },
        "percentileCurves": {
            "publish":  pub_curve,
            "endToEnd": e2e_curve,
        },
        "histograms": {
            "publish":  _build_histogram(pub_curve),
            "endToEnd": _build_histogram(e2e_curve),
        },
        "timeSeries": {
            "publishRate":         data.get("publishRate", []),
            "consumeRate":         data.get("consumeRate", []),
            "backlog":             data.get("backlog", []),
            "publishLatencyP99":   data.get("publishLatency99pct", []),
            "publishLatencyP999":  data.get("publishLatency999pct", []),
            "endToEndLatencyP99":  data.get("endToEndLatency99pct", []),
            "endToEndLatencyP999": data.get("endToEndLatency999pct", []),
        },
    }


async def parse_and_store_hdr_results(
    run_id: int, max_retries: int = 5, retry_delay: float = 2.0
) -> bool:
    """
    Find, parse, and store HDR results for run_id. Retries if file not found.
    Skips silently if row already exists. Returns True on success.
    """
    from database import AsyncSessionLocal
    from models import RunResult

    path = None
    for attempt in range(max_retries):
        path = _find_result_file(run_id)
        if path:
            break
        logger.debug(
            "HDR parse: file not found for run %d (attempt %d/%d)",
            run_id, attempt + 1, max_retries,
        )
        await asyncio.sleep(retry_delay)

    if not path:
        logger.warning(
            "HDR parse: result file not found for run %d after %d retries",
            run_id, max_retries,
        )
        return False

    parsed = parse_hdr_results_from_file(path)
    if not parsed:
        logger.warning("HDR parse: could not parse result file for run %d at %s", run_id, path)
        return False

    agg = parsed["aggregates"]
    pub = agg["publish"]
    e2e = agg["endToEnd"]
    curves = parsed["percentileCurves"]

    async with AsyncSessionLocal() as db:
        existing = await db.get(RunResult, run_id)
        if existing:
            return True
        row = RunResult(
            run_id=run_id,
            publish_p50=pub.get("p50"),
            publish_p75=pub.get("p75"),
            publish_p95=pub.get("p95"),
            publish_p99=pub.get("p99"),
            publish_p999=pub.get("p999"),
            publish_p9999=pub.get("p9999"),
            publish_max=pub.get("max"),
            publish_avg=pub.get("avg"),
            e2e_p50=e2e.get("p50"),
            e2e_p75=e2e.get("p75"),
            e2e_p95=e2e.get("p95"),
            e2e_p99=e2e.get("p99"),
            e2e_p999=e2e.get("p999"),
            e2e_p9999=e2e.get("p9999"),
            e2e_max=e2e.get("max"),
            e2e_avg=e2e.get("avg"),
            publish_quantiles_json=json.dumps(curves["publish"]),
            e2e_quantiles_json=json.dumps(curves["endToEnd"]),
            parsed_at=datetime.utcnow(),
        )
        db.add(row)
        try:
            await db.commit()
        except Exception as exc:
            await db.rollback()
            logger.error("HDR parse: DB commit failed for run %d: %s", run_id, exc)
            return False

    logger.info("HDR parse: stored results for run %d from %s", run_id, path)
    return True
```

- [ ] **Step 4: Run tests to confirm they pass**

```bash
cd /Users/cnelson/sandbox/omb_k8s/aws_private/omb-k8s/control-plane
python -m pytest tests/test_hdr_result_parser.py -v
```

Expected: all 9 tests PASS.

- [ ] **Step 5: Commit**

```bash
cd /Users/cnelson/sandbox/omb_k8s/aws_private/omb-k8s
git add control-plane/services/hdr_result_parser.py control-plane/tests/test_hdr_result_parser.py
git commit -m "feat: add HDR result file parser service with tests"
```

---

## Task 3: Add GET /api/runs/{run_id}/results endpoint and trigger from _finish_run

**Files:**
- Modify: `control-plane/routers/runs.py`

- [ ] **Step 1: Add the GET results endpoint**

In `control-plane/routers/runs.py`, add this route after the `delete_run` route (around line 138, before the broker Prometheus helpers):

```python
@router.get("/{run_id}/results")
async def get_run_results(run_id: int):
    """
    Return HDR percentile results for a completed run.
    Reads the OMB JSON result file directly. Returns 404 if not yet available.
    """
    from services.hdr_result_parser import _find_result_file, parse_hdr_results_from_file

    path = _find_result_file(run_id)
    if not path:
        raise HTTPException(status_code=404, detail="Result file not available yet")

    parsed = parse_hdr_results_from_file(path)
    if not parsed:
        raise HTTPException(status_code=404, detail="Result file could not be parsed")

    return parsed
```

- [ ] **Step 2: Trigger HDR parsing from _finish_run after the file rename**

In `_finish_run`, after the `try: _os.rename(source, dest)` block (around line 265), add:

```python
        # Kick off HDR percentile parsing in the background after the rename.
        # parse_and_store_hdr_results retries up to 5 times if the file isn't
        # visible yet due to filesystem sync delays.
        asyncio.create_task(
            parse_and_store_hdr_results(run_id)
        )
```

And at the top of `_finish_run`, add the import alongside the existing `import glob as _glob` block:

```python
        from services.hdr_result_parser import parse_and_store_hdr_results as _parse_hdr
```

Then change the `asyncio.create_task` call to use `_parse_hdr`:

```python
        asyncio.create_task(_parse_hdr(run_id))
```

The full updated `_finish_run` rename block (lines 253-293 of runs.py) should look like:

```python
        # Rename the result file to a descriptive name so it persists on the PVC.
        import glob as _glob
        import os as _os
        from services.hdr_result_parser import parse_and_store_hdr_results as _parse_hdr

        candidates = _glob.glob(results_file_path) + _glob.glob(f"{results_file_path}*.json")
        if candidates:
            source = max(candidates, key=_os.path.getmtime)
            if run.sweep_id:
                dest = f"/data/results/sweep-{run.sweep_id}-run-{run_id}.json"
            else:
                dest = f"/data/results/run-{run_id}.json"
            try:
                _os.rename(source, dest)
            except Exception as exc:
                logger.warning("Could not rename result file %s -> %s: %s", source, dest, exc)

        # Parse HDR percentile data after the file rename completes.
        asyncio.create_task(_parse_hdr(run_id))
```

- [ ] **Step 3: Run existing backend tests to confirm nothing broke**

```bash
cd /Users/cnelson/sandbox/omb_k8s/aws_private/omb-k8s/control-plane
python -m pytest tests/ -v
```

Expected: all tests PASS.

- [ ] **Step 4: Commit**

```bash
cd /Users/cnelson/sandbox/omb_k8s/aws_private/omb-k8s
git add control-plane/routers/runs.py
git commit -m "feat: add GET /api/runs/{id}/results endpoint and trigger HDR parse on completion"
```

---

## Task 4: Install Plotly and add getRunResults to api.js

**Files:**
- Modify: `control-plane/frontend/package.json`
- Modify: `control-plane/frontend/src/api.js`

- [ ] **Step 1: Install plotly.js-dist-min and react-plotly.js**

```bash
cd /Users/cnelson/sandbox/omb_k8s/aws_private/omb-k8s/control-plane/frontend
npm install plotly.js-dist-min react-plotly.js
```

Expected: package.json updated with both packages in `dependencies`. No errors.

- [ ] **Step 2: Add getRunResults to api.js**

In `control-plane/frontend/src/api.js`, append after the `cancelRun` export:

```js
export const getRunResults = (runId) => request('GET', `/runs/${runId}/results`)
```

- [ ] **Step 3: Commit**

```bash
cd /Users/cnelson/sandbox/omb_k8s/aws_private/omb-k8s
git add control-plane/frontend/package.json control-plane/frontend/package-lock.json control-plane/frontend/src/api.js
git commit -m "feat: install plotly, add getRunResults API call"
```

---

## Task 5: Create FinalizedCharts component

**Files:**
- Create: `control-plane/frontend/src/components/FinalizedCharts.jsx`

- [ ] **Step 1: Create FinalizedCharts.jsx**

Create `control-plane/frontend/src/components/FinalizedCharts.jsx` with the full implementation:

```jsx
import React, { useMemo } from 'react'
import {
  LineChart, Line, BarChart, Bar,
  XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer,
} from 'recharts'
import Plotly from 'plotly.js-dist-min'
import createPlotlyComponent from 'react-plotly.js/factory'

const Plot = createPlotlyComponent(Plotly)

// Dark theme palette matching the existing RunCharts color scheme
const C = {
  publish:  '#e63946',
  e2e:      '#6ee7b7',
  grid:     '#2a3045',
  axis:     '#7a8399',
  bg:       '#171c28',
  paper:    '#1e2538',
  text:     '#e8edf8',
}

const PLOTLY_BASE_LAYOUT = {
  paper_bgcolor: C.paper,
  plot_bgcolor:  C.bg,
  font:   { color: C.text, size: 11 },
  margin: { t: 36, r: 16, b: 50, l: 60 },
  xaxis: { gridcolor: C.grid, linecolor: C.grid, tickcolor: C.axis, color: C.axis },
  yaxis: { gridcolor: C.grid, linecolor: C.grid, tickcolor: C.axis, color: C.axis },
  showlegend: false,
}

const PCT_TICKS = [50, 90, 99, 99.9, 99.99, 99.999]
const PCT_TICK_LABELS = ['50', '90', '99', '99.9', '99.99', '99.999']

function fmtMs(v, decimals = 3) {
  if (v == null) return '—'
  return v.toFixed(decimals)
}

// ── Nines Table ─────────────────────────────────────────────────────────────

function NinesTable({ aggregates }) {
  const { publish, endToEnd } = aggregates
  const rows = [
    { label: 'Avg',    pubKey: 'avg',   e2eKey: 'avg'   },
    { label: 'P50',    pubKey: 'p50',   e2eKey: 'p50'   },
    { label: 'P75',    pubKey: 'p75',   e2eKey: 'p75'   },
    { label: 'P95',    pubKey: 'p95',   e2eKey: 'p95'   },
    { label: 'P99',    pubKey: 'p99',   e2eKey: 'p99'   },
    { label: 'P99.9',  pubKey: 'p999',  e2eKey: 'p999'  },
    { label: 'P99.99', pubKey: 'p9999', e2eKey: 'p9999' },
    { label: 'Max',    pubKey: 'max',   e2eKey: 'max'   },
  ]

  function latencyColor(key, value) {
    if (key !== 'p99' || value == null) return undefined
    if (value > 20) return '#ef4444'
    if (value > 10) return '#f59e0b'
    return undefined
  }

  return (
    <table style={{
      width: '100%', borderCollapse: 'collapse',
      fontSize: 13, color: C.text,
    }}>
      <thead>
        <tr style={{ borderBottom: `1px solid ${C.grid}` }}>
          <th style={{ textAlign: 'left', padding: '6px 12px', color: C.axis, fontWeight: 600, fontSize: 11, textTransform: 'uppercase', letterSpacing: '0.06em' }}>
            Percentile
          </th>
          <th style={{ textAlign: 'right', padding: '6px 12px', color: C.publish, fontWeight: 600 }}>Publish (ms)</th>
          <th style={{ textAlign: 'right', padding: '6px 12px', color: C.e2e,     fontWeight: 600 }}>E2E (ms)</th>
        </tr>
      </thead>
      <tbody>
        {rows.map(({ label, pubKey, e2eKey }) => {
          const pubVal = publish[pubKey]
          const e2eVal = endToEnd[e2eKey]
          return (
            <tr key={label} style={{ borderBottom: `1px solid rgba(42,48,69,0.5)` }}>
              <td style={{ padding: '5px 12px', color: C.axis, fontWeight: pubKey === 'p99' || pubKey === 'p999' ? 600 : 400 }}>
                {label}
              </td>
              <td style={{ padding: '5px 12px', textAlign: 'right', fontWeight: 600, color: latencyColor(pubKey, pubVal) }}>
                {fmtMs(pubVal)}
              </td>
              <td style={{ padding: '5px 12px', textAlign: 'right', fontWeight: 600, color: latencyColor(e2eKey, e2eVal) }}>
                {fmtMs(e2eVal)}
              </td>
            </tr>
          )
        })}
      </tbody>
    </table>
  )
}

// ── Percentile Curve — Recharts ──────────────────────────────────────────────

function PercentileCurveRecharts({ data, title, color }) {
  if (!data || data.length === 0) return <div style={{ color: C.axis, fontSize: 12, padding: 8 }}>No data</div>
  return (
    <div>
      <div style={{ fontSize: 12, color: C.text, marginBottom: 6, fontWeight: 500 }}>{title}</div>
      <ResponsiveContainer width="100%" height={220}>
        <LineChart data={data} margin={{ top: 4, right: 16, bottom: 20, left: 10 }}>
          <CartesianGrid strokeDasharray="3 3" stroke={C.grid} />
          <XAxis
            dataKey="percentile"
            scale="log"
            type="number"
            domain={[50, 99.999]}
            ticks={PCT_TICKS}
            tickFormatter={v => {
              if (v >= 99.999) return '99.999'
              if (v >= 99.99)  return '99.99'
              if (v >= 99.9)   return '99.9'
              if (v >= 99)     return '99'
              if (v >= 90)     return '90'
              return '50'
            }}
            stroke={C.axis}
            tick={{ fill: C.axis, fontSize: 10 }}
            label={{ value: 'Percentile', position: 'insideBottom', offset: -10, fill: C.axis, fontSize: 10 }}
          />
          <YAxis
            stroke={C.axis}
            tick={{ fill: C.axis, fontSize: 10 }}
            width={50}
            label={{ value: 'ms', angle: -90, position: 'insideLeft', fill: C.axis, fontSize: 10 }}
          />
          <Tooltip
            contentStyle={{ background: '#171c28', border: '1px solid #2a3045', color: C.text, fontSize: 11 }}
            formatter={(v) => [`${v.toFixed(3)} ms`, 'latency']}
            labelFormatter={v => `P${v}`}
          />
          <Line type="monotone" dataKey="latencyMs" stroke={color} dot={false} strokeWidth={2} />
        </LineChart>
      </ResponsiveContainer>
    </div>
  )
}

// ── Percentile Curve — Plotly ────────────────────────────────────────────────

function PercentileCurvePlotly({ data, title, color }) {
  if (!data || data.length === 0) return <div style={{ color: C.axis, fontSize: 12, padding: 8 }}>No data</div>
  const plotData = [{
    x: data.map(p => p.percentile),
    y: data.map(p => p.latencyMs),
    type: 'scatter',
    mode: 'lines',
    line: { color, width: 2 },
    hovertemplate: 'P%{x:.3f}<br>%{y:.3f} ms<extra></extra>',
  }]
  const layout = {
    ...PLOTLY_BASE_LAYOUT,
    title: { text: title, font: { color: C.text, size: 12 }, x: 0.05, y: 0.97 },
    height: 250,
    xaxis: {
      ...PLOTLY_BASE_LAYOUT.xaxis,
      type: 'log',
      tickmode: 'array',
      tickvals: PCT_TICKS,
      ticktext: PCT_TICK_LABELS,
      title: { text: 'Percentile', font: { size: 10, color: C.axis }, standoff: 8 },
    },
    yaxis: {
      ...PLOTLY_BASE_LAYOUT.yaxis,
      title: { text: 'Latency (ms)', font: { size: 10, color: C.axis }, standoff: 8 },
    },
  }
  return (
    <Plot
      data={plotData}
      layout={layout}
      config={{ displayModeBar: false, responsive: true }}
      style={{ width: '100%' }}
      useResizeHandler
    />
  )
}

// ── Histogram — Recharts ─────────────────────────────────────────────────────

function HistogramRecharts({ data, title, color }) {
  if (!data || data.length === 0) return <div style={{ color: C.axis, fontSize: 12, padding: 8 }}>No data</div>
  // Show every 5th tick label to avoid crowding
  const ticks = data.filter((_, i) => i % 5 === 0).map(b => b.bucketLabel)
  return (
    <div>
      <div style={{ fontSize: 12, color: C.text, marginBottom: 6, fontWeight: 500 }}>{title}</div>
      <ResponsiveContainer width="100%" height={220}>
        <BarChart data={data} margin={{ top: 4, right: 16, bottom: 20, left: 10 }}>
          <CartesianGrid strokeDasharray="3 3" stroke={C.grid} vertical={false} />
          <XAxis
            dataKey="bucketLabel"
            stroke={C.axis}
            tick={{ fill: C.axis, fontSize: 9 }}
            ticks={ticks}
            label={{ value: 'Latency (ms)', position: 'insideBottom', offset: -10, fill: C.axis, fontSize: 10 }}
          />
          <YAxis
            stroke={C.axis}
            tick={{ fill: C.axis, fontSize: 10 }}
            width={45}
            tickFormatter={v => `${v}%`}
          />
          <Tooltip
            contentStyle={{ background: '#171c28', border: '1px solid #2a3045', color: C.text, fontSize: 11 }}
            formatter={v => [`${v.toFixed(2)}%`, '% messages']}
            labelFormatter={v => `~${v} ms`}
          />
          <Bar dataKey="percentage" fill={color} opacity={0.8} />
        </BarChart>
      </ResponsiveContainer>
    </div>
  )
}

// ── Histogram — Plotly ───────────────────────────────────────────────────────

function HistogramPlotly({ data, title, color }) {
  if (!data || data.length === 0) return <div style={{ color: C.axis, fontSize: 12, padding: 8 }}>No data</div>
  const plotData = [{
    x: data.map(b => parseFloat(b.bucketLabel)),
    y: data.map(b => b.percentage),
    type: 'bar',
    marker: { color, opacity: 0.8 },
    hovertemplate: '~%{x:.2f} ms<br>%{y:.2f}%<extra></extra>',
  }]
  const layout = {
    ...PLOTLY_BASE_LAYOUT,
    title: { text: title, font: { color: C.text, size: 12 }, x: 0.05, y: 0.97 },
    height: 250,
    xaxis: {
      ...PLOTLY_BASE_LAYOUT.xaxis,
      title: { text: 'Latency (ms)', font: { size: 10, color: C.axis }, standoff: 8 },
    },
    yaxis: {
      ...PLOTLY_BASE_LAYOUT.yaxis,
      title: { text: '% messages', font: { size: 10, color: C.axis }, standoff: 8 },
      ticksuffix: '%',
    },
  }
  return (
    <Plot
      data={plotData}
      layout={layout}
      config={{ displayModeBar: false, responsive: true }}
      style={{ width: '100%' }}
      useResizeHandler
    />
  )
}

// ── Library comparison label ─────────────────────────────────────────────────

function LibLabel({ children }) {
  return (
    <div style={{
      fontSize: 10, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.1em',
      color: C.axis, marginBottom: 4, paddingBottom: 4,
      borderBottom: `1px solid ${C.grid}`,
    }}>
      {children}
    </div>
  )
}

// ── Section heading ──────────────────────────────────────────────────────────

function SectionHeading({ children }) {
  return (
    <div style={{
      fontSize: 11, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.08em',
      color: C.axis, marginBottom: 12, marginTop: 20, paddingBottom: 6,
      borderBottom: `1px solid ${C.grid}`,
    }}>
      {children}
    </div>
  )
}

// ── Main export ──────────────────────────────────────────────────────────────

export default function FinalizedCharts({ results }) {
  if (!results) return null
  const { aggregates, percentileCurves, histograms } = results
  const pubCurve = percentileCurves?.publish  || []
  const e2eCurve = percentileCurves?.endToEnd || []
  const pubHist  = histograms?.publish        || []
  const e2eHist  = histograms?.endToEnd       || []

  return (
    <div>
      {/* ── Results summary — nines table ── */}
      <SectionHeading>Results summary</SectionHeading>
      <div className="card" style={{ padding: '0 0 4px' }}>
        <NinesTable aggregates={aggregates} />
      </div>

      {/* ── Latency distribution — percentile curves ── */}
      <SectionHeading>Latency distribution — percentile curves</SectionHeading>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
        <div className="chart-card">
          <LibLabel>Recharts</LibLabel>
          <PercentileCurveRecharts
            data={pubCurve}
            title="Publish latency percentile curve"
            color={C.publish}
          />
        </div>
        <div className="chart-card">
          <LibLabel>Plotly</LibLabel>
          <PercentileCurvePlotly
            data={pubCurve}
            title="Publish latency percentile curve"
            color={C.publish}
          />
        </div>
        <div className="chart-card">
          <LibLabel>Recharts</LibLabel>
          <PercentileCurveRecharts
            data={e2eCurve}
            title="End-to-end latency percentile curve"
            color={C.e2e}
          />
        </div>
        <div className="chart-card">
          <LibLabel>Plotly</LibLabel>
          <PercentileCurvePlotly
            data={e2eCurve}
            title="End-to-end latency percentile curve"
            color={C.e2e}
          />
        </div>
      </div>

      {/* ── Latency distribution — histograms ── */}
      <SectionHeading>Latency distribution — histograms</SectionHeading>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
        <div className="chart-card">
          <LibLabel>Recharts</LibLabel>
          <HistogramRecharts
            data={pubHist}
            title="Publish latency histogram"
            color={C.publish}
          />
        </div>
        <div className="chart-card">
          <LibLabel>Plotly</LibLabel>
          <HistogramPlotly
            data={pubHist}
            title="Publish latency histogram"
            color={C.publish}
          />
        </div>
        <div className="chart-card">
          <LibLabel>Recharts</LibLabel>
          <HistogramRecharts
            data={e2eHist}
            title="End-to-end latency histogram"
            color={C.e2e}
          />
        </div>
        <div className="chart-card">
          <LibLabel>Plotly</LibLabel>
          <HistogramPlotly
            data={e2eHist}
            title="End-to-end latency histogram"
            color={C.e2e}
          />
        </div>
      </div>
    </div>
  )
}
```

- [ ] **Step 2: Verify the build compiles without errors**

```bash
cd /Users/cnelson/sandbox/omb_k8s/aws_private/omb-k8s/control-plane/frontend
npm run build 2>&1 | tail -20
```

Expected: build completes without errors. Warnings about bundle size for plotly are expected.

- [ ] **Step 3: Commit**

```bash
cd /Users/cnelson/sandbox/omb_k8s/aws_private/omb-k8s
git add control-plane/frontend/src/components/FinalizedCharts.jsx
git commit -m "feat: add FinalizedCharts component with Recharts and Plotly implementations"
```

---

## Task 6: Update RunDetailPage to show finalized view after completion

**Files:**
- Modify: `control-plane/frontend/src/pages/RunDetailPage.jsx`

- [ ] **Step 1: Add import and state for HDR results**

At the top of `RunDetailPage.jsx`, add the import after the existing imports:

```js
import FinalizedCharts from '../components/FinalizedCharts.jsx'
import { getRunResults } from '../api.js'
```

Inside the `RunDetailPage` function body, after the existing state declarations (around line 125), add:

```js
const [hdrResults, setHdrResults] = useState(null)
const [hdrLoading, setHdrLoading] = useState(false)
```

- [ ] **Step 2: Add useEffect to fetch HDR results after run completes**

After the `useEffect` for Prometheus samples (around line 283), add:

```js
  // Fetch HDR results from the results file once run completes.
  // getRunResults returns 404 until _finish_run has renamed the file, so
  // we retry with a short backoff — the file typically appears within 2-5s.
  useEffect(() => {
    if (run?.status !== 'completed') return
    setHdrLoading(true)
    let cancelled = false
    async function fetchWithRetry(attempts = 8, delay = 1500) {
      for (let i = 0; i < attempts; i++) {
        if (cancelled) return
        try {
          const data = await getRunResults(id)
          if (!cancelled) { setHdrResults(data); setHdrLoading(false) }
          return
        } catch (e) {
          if (e.status !== 404) { setHdrLoading(false); return }
          if (i < attempts - 1) await new Promise(r => setTimeout(r, delay))
        }
      }
      if (!cancelled) setHdrLoading(false)
    }
    fetchWithRetry()
    return () => { cancelled = true }
  }, [id, run?.status])
```

- [ ] **Step 3: Replace the post-completion layout in the JSX**

Find the block that renders when `m` is non-null (around line 482):

```jsx
      {/* Summary metrics — only shown after run completes */}
      {m && (
        <>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr 1fr', gap: 12, marginBottom: 12 }}>
            ...
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr 1fr', gap: 12, marginBottom: 16 }}>
            ...
          </div>
        </>
      )}

      {/* Charts — live during run, post-run from stored metrics + Prometheus */}
      <RunCharts ... />
```

Replace the entire `{m && (...)}` block AND the `<RunCharts ... />` call with:

```jsx
      {/* Post-completion finalized view */}
      {run.status === 'completed' && m && (
        <>
          {/* Throughput tiles — 2 columns only (actual vs target) */}
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12, marginBottom: 16 }}>
            <TileColumn label="Avg Publish Rate" badge="omb">
              <MetricCard value={fmt(m.publish_rate_avg)} unit="msg/s" expected={expectedMsgSec > 0 ? expectedMsgSec : undefined} />
              <MetricCard value={fmt(m.publish_rate_avg * messageSize / 1_048_576, 2)} unit="MB/s" expected={expectedMBSec > 0 ? expectedMBSec : undefined} />
            </TileColumn>
            <TileColumn label="Avg Consume Rate" badge="omb">
              <MetricCard value={fmt(m.consume_rate_avg)} unit="msg/s" expected={expectedMsgSec > 0 ? expectedMsgSec : undefined} />
              <MetricCard value={fmt(m.consume_rate_avg * messageSize / 1_048_576, 2)} unit="MB/s" expected={expectedMBSec > 0 ? expectedMBSec : undefined} />
            </TileColumn>
          </div>

          {/* HDR finalized charts */}
          {hdrLoading && (
            <div style={{ color: 'var(--color-text-muted)', fontSize: 13, padding: '12px 0' }}>
              <span className="spinner spinner-dark" style={{ marginRight: 8 }} />
              Loading results…
            </div>
          )}
          {hdrResults && <FinalizedCharts results={hdrResults} />}

          {/* Collapsed live charts */}
          <details style={{ marginTop: 20 }}>
            <summary style={{
              cursor: 'pointer', fontWeight: 600, fontSize: 14,
              color: 'var(--color-text-muted)', padding: '8px 0', userSelect: 'none',
            }}>
              Raw time series data ▶
            </summary>
            <div style={{ marginTop: 12 }}>
              <RunCharts
                livePoints={livePoints}
                metricsOut={run?.metrics ?? null}
                promSamples={promSamples}
                isLive={false}
                messageSize={messageSize}
                warmupSamples={warmupSamples}
                totalSamples={totalSamples}
                warmupStartedAt={warmupStartedAt}
                benchmarkStartedAt={benchmarkStartedAt}
                workerMemLimitMiB={workerResources?.memory_limit_mib ?? null}
                workerCpuCores={workerResources?.cpu_request_cores ?? null}
                runStartedAt={run?.started_at ?? null}
                expectedMsgSec={expectedMsgSec}
                expectedMBSec={expectedMBSec}
                expectedConsMsgSec={expectedConsMsgSec}
                expectedConsMBSec={expectedConsMBSec}
              />
            </div>
          </details>
        </>
      )}

      {/* Live run charts — shown during active run */}
      {run.status !== 'completed' && (
        <RunCharts
          livePoints={livePoints}
          metricsOut={run?.metrics ?? null}
          promSamples={promSamples}
          isLive={run?.status === 'running'}
          messageSize={messageSize}
          warmupSamples={warmupSamples}
          totalSamples={totalSamples}
          warmupStartedAt={warmupStartedAt}
          benchmarkStartedAt={benchmarkStartedAt}
          workerMemLimitMiB={workerResources?.memory_limit_mib ?? null}
          workerCpuCores={workerResources?.cpu_request_cores ?? null}
          runStartedAt={run?.started_at ?? null}
          expectedMsgSec={expectedMsgSec}
          expectedMBSec={expectedMBSec}
          expectedConsMsgSec={expectedConsMsgSec}
          expectedConsMBSec={expectedConsMBSec}
        />
      )}
```

- [ ] **Step 4: Build and verify no TypeScript/build errors**

```bash
cd /Users/cnelson/sandbox/omb_k8s/aws_private/omb-k8s/control-plane/frontend
npm run build 2>&1 | tail -20
```

Expected: build completes without errors.

- [ ] **Step 5: Run frontend tests**

```bash
cd /Users/cnelson/sandbox/omb_k8s/aws_private/omb-k8s/control-plane/frontend
npm test 2>&1 | tail -20
```

Expected: all existing tests pass.

- [ ] **Step 6: Commit**

```bash
cd /Users/cnelson/sandbox/omb_k8s/aws_private/omb-k8s
git add control-plane/frontend/src/pages/RunDetailPage.jsx
git commit -m "feat: show finalized HDR charts after run completion, collapse live charts"
```

---

## Self-Review Checklist

**Spec coverage:**

| Requirement | Covered by |
|-------------|------------|
| GET /api/runs/{id}/results endpoint | Task 3 Step 1 |
| Returns metadata, aggregates, percentileCurves, timeSeries | Task 2 parse_hdr_results_from_file |
| Percentile curves thinned to every 10th, >= 50.0 only | Task 2 _thin_quantiles |
| Returns 404 if file not present | Task 3 Step 1 |
| run_results SQLite table | Task 1 |
| Store parsed aggregates on completion | Task 2 parse_and_store_hdr_results |
| Trigger parsing on Job completion (up to 5 retries, 2s delay) | Task 3 Step 2 |
| Histograms (~30 equal-width buckets) | Task 2 _build_histogram — **included in API response** |
| Existing Recharts charts untouched | Task 6 — RunCharts props identical, just conditionally rendered |
| Recharts + Plotly versions side by side | Task 5 FinalizedCharts |
| Dark theme for Plotly | Task 5 PLOTLY_BASE_LAYOUT |
| Log scale x-axis on percentile curves | Task 5 XAxis scale="log" (Recharts) + xaxis.type='log' (Plotly) |
| x-axis ticks at 50, 90, 99, 99.9, 99.99, 99.999 | Task 5 PCT_TICKS |
| Nines table: avg/p50/p75/p95/p99/p99.9/p99.99/max | Task 5 NinesTable rows |
| p99 > 10ms amber, p99 > 20ms red | Task 5 latencyColor function |
| 2x2 grid layout for percentile curves | Task 5 |
| 2x2 grid layout for histograms | Task 5 |
| Live charts collapse to disclosure after completion | Task 6 Step 3 |
| Throughput tiles remain visible | Task 6 Step 3 (2-col grid) |
| LatencyColumn tiles removed from completed view | Task 6 Step 3 (not present in new layout) |
| Titles "Publish latency percentile curve" / "End-to-end latency percentile curve" | Task 5 |
| Titles "Publish latency histogram" / "End-to-end latency histogram" | Task 5 |
| "Raw time series data ▶" disclosure label | Task 6 Step 3 |
| Frontend polls after completion (retry on 404) | Task 6 Step 2 |
| Do not implement schedule latency charts | ✓ not included |
| Do not implement sweep comparison charts | ✓ not included |
| Do not touch Terraform/Helm/CI | ✓ |

**Placeholder scan:** None found — all steps include complete code.

**Type consistency:**
- `_thin_quantiles` returns `list[dict]` with keys `percentile` and `latencyMs` — matches FinalizedCharts `.map(p => p.percentile)` and `.map(p => p.latencyMs)`
- `_build_histogram` returns `list[dict]` with keys `bucketLabel` and `percentage` — matches Recharts `dataKey="bucketLabel"` / `dataKey="percentage"` and Plotly `b.bucketLabel` / `b.percentage`
- `parse_and_store_hdr_results` uses `pub.get("p50")` etc. — matches `RunResult.publish_p50` column name
- `getRunResults(id)` in frontend — matches backend route `GET /api/runs/{run_id}/results`
- `results.aggregates.publish.p99` in NinesTable — matches `aggregates.publish.p99` in API response
- `results.percentileCurves.publish` — matches `percentileCurves.publish` in API response
- `results.histograms.publish` — matches `histograms.publish` in API response
