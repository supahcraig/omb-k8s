# Grafana Deep-Link Integration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add Grafana deep-links to the sidebar, run detail page, and sweep detail page so SEs can jump directly into the Redpanda Ops Dashboard pre-scoped to the relevant time window.

**Architecture:** A new backend endpoint (`GET /api/grafana/url`) reads the `omb-grafana` k8s Service's LoadBalancer address and returns it as JSON. The frontend fetches this once via a `useGrafanaUrl()` hook and uses a `buildGrafanaUrl()` utility to construct deep-links with the correct Grafana time range parameters.

**Tech Stack:** FastAPI (Python), React 18, Vitest, pytest, kubernetes Python client

---

## File Map

**New files:**
- `control-plane/routers/grafana.py` — `GET /api/grafana/url` endpoint
- `control-plane/tests/test_grafana_router.py` — backend unit tests
- `control-plane/frontend/src/lib/grafanaUtils.js` — `buildGrafanaUrl` utility
- `control-plane/frontend/src/lib/__tests__/grafanaUtils.test.js` — frontend unit tests
- `control-plane/frontend/src/hooks/useGrafanaUrl.js` — React hook

**Modified files:**
- `control-plane/main.py` — register grafana router at `/api/grafana`
- `control-plane/frontend/src/api.js` — add `getGrafanaUrl`
- `control-plane/frontend/src/components/Layout.jsx` — add Monitoring section with Grafana link
- `control-plane/frontend/src/pages/RunDetailPage.jsx` — add Grafana link in run header
- `control-plane/frontend/src/pages/SweepDetailPage.jsx` — add Grafana link above comparison table

---

## Task 1: Backend — `GET /api/grafana/url`

**Files:**
- Create: `control-plane/routers/grafana.py`
- Create: `control-plane/tests/test_grafana_router.py`
- Modify: `control-plane/main.py`

- [ ] **Step 1: Write the failing tests**

Create `control-plane/tests/test_grafana_router.py`:

```python
import pytest
from unittest.mock import MagicMock, patch


def _make_ingress(hostname=None, ip=None):
    ing = MagicMock()
    ing.hostname = hostname
    ing.ip = ip
    return ing


def _make_svc(ingress_list):
    svc = MagicMock()
    svc.spec.type = "LoadBalancer"
    svc.status.load_balancer.ingress = ingress_list
    return svc


@pytest.mark.asyncio
async def test_returns_hostname_when_present():
    from routers.grafana import _get_grafana_url
    svc = _make_svc([_make_ingress(hostname="abc.elb.amazonaws.com")])
    result = await _get_grafana_url(svc)
    assert result == "http://abc.elb.amazonaws.com"


@pytest.mark.asyncio
async def test_returns_ip_when_no_hostname():
    from routers.grafana import _get_grafana_url
    svc = _make_svc([_make_ingress(hostname=None, ip="1.2.3.4")])
    result = await _get_grafana_url(svc)
    assert result == "http://1.2.3.4"


@pytest.mark.asyncio
async def test_returns_none_when_no_ingress():
    from routers.grafana import _get_grafana_url
    svc = _make_svc([])
    result = await _get_grafana_url(svc)
    assert result is None


@pytest.mark.asyncio
async def test_returns_none_when_ingress_is_none():
    from routers.grafana import _get_grafana_url
    svc = _make_svc(None)
    result = await _get_grafana_url(svc)
    assert result is None


@pytest.mark.asyncio
async def test_returns_none_when_not_loadbalancer():
    from routers.grafana import _get_grafana_url
    svc = MagicMock()
    svc.spec.type = "ClusterIP"
    result = await _get_grafana_url(svc)
    assert result is None
```

- [ ] **Step 2: Run tests to confirm they fail**

```bash
cd /Users/cnelson/sandbox/omb_k8s/aws_private/omb-k8s/control-plane
python -m pytest tests/test_grafana_router.py -v 2>&1 | tail -15
```

Expected: `ImportError` or `ModuleNotFoundError` — `routers.grafana` doesn't exist yet.

- [ ] **Step 3: Create `control-plane/routers/grafana.py`**

```python
"""Grafana service URL discovery."""
import logging
from typing import Optional

from fastapi import APIRouter

from config import settings
from services.k8s_client import get_k8s_clients, run_sync

logger = logging.getLogger(__name__)

router = APIRouter()

_GRAFANA_SERVICE = "omb-grafana"


async def _get_grafana_url(svc) -> Optional[str]:
    """Extract the external URL from a k8s Service object. Returns None if unavailable."""
    if svc.spec.type != "LoadBalancer":
        return None
    ingress = svc.status.load_balancer.ingress
    if not ingress:
        return None
    entry = ingress[0]
    host = entry.hostname or entry.ip
    if not host:
        return None
    return f"http://{host}"


@router.get("/url")
async def get_grafana_url() -> dict:
    """Return the Grafana LoadBalancer URL, or null if unavailable."""
    try:
        core_api, _, _ = get_k8s_clients()
        svc = await run_sync(
            core_api.read_namespaced_service,
            _GRAFANA_SERVICE,
            settings.omb_namespace,
        )
        url = await _get_grafana_url(svc)
        return {"url": url}
    except Exception:
        logger.debug("Could not read Grafana service URL", exc_info=True)
        return {"url": None}
```

- [ ] **Step 4: Run tests to confirm they pass**

```bash
cd /Users/cnelson/sandbox/omb_k8s/aws_private/omb-k8s/control-plane
python -m pytest tests/test_grafana_router.py -v 2>&1 | tail -15
```

Expected: all 5 tests pass.

- [ ] **Step 5: Register the router in `main.py`**

In `control-plane/main.py`, add to `_routers_to_mount`:

```python
_routers_to_mount = [
    ("routers.runs", "/api/runs", ["runs"]),
    ("routers.sweeps", "/api/sweeps", ["sweeps"]),
    ("routers.workloads", "/api/workloads", ["workloads"]),
    ("routers.settings", "/api/settings", ["settings"]),
    ("routers.workers", "/api/workers", ["workers"]),
    ("routers.prometheus", "/api/prometheus", ["prometheus"]),
    ("routers.cluster",   "/api/cluster",    ["cluster"]),
    ("routers.grafana",   "/api/grafana",    ["grafana"]),   # ← add this line
]
```

- [ ] **Step 6: Run full backend test suite**

```bash
cd /Users/cnelson/sandbox/omb_k8s/aws_private/omb-k8s/control-plane
python -m pytest tests/ -v 2>&1 | tail -15
```

Expected: all existing tests still pass plus the 5 new ones.

- [ ] **Step 7: Commit**

```bash
cd /Users/cnelson/sandbox/omb_k8s/aws_private/omb-k8s
git add control-plane/routers/grafana.py \
        control-plane/tests/test_grafana_router.py \
        control-plane/main.py
git commit -m "feat: add GET /api/grafana/url endpoint"
```

---

## Task 2: Frontend — `grafanaUtils.js` with tests

**Files:**
- Create: `control-plane/frontend/src/lib/grafanaUtils.js`
- Create: `control-plane/frontend/src/lib/__tests__/grafanaUtils.test.js`

- [ ] **Step 1: Write the failing tests**

Create `control-plane/frontend/src/lib/__tests__/grafanaUtils.test.js`:

```js
import { describe, it, expect } from 'vitest'
import { buildGrafanaUrl } from '../grafanaUtils.js'

const BASE = 'http://abc.elb.amazonaws.com'
const UID  = 'FejE4c6nz'

describe('buildGrafanaUrl', () => {
  it('builds relative time range', () => {
    const url = buildGrafanaUrl(BASE, 'now-6h', 'now')
    expect(url).toBe(`${BASE}/d/${UID}/redpanda-ops-dashboard?orgId=1&from=now-6h&to=now`)
  })

  it('builds absolute time range from ms timestamps', () => {
    const url = buildGrafanaUrl(BASE, 1000000000000, 1000003600000)
    expect(url).toBe(`${BASE}/d/${UID}/redpanda-ops-dashboard?orgId=1&from=1000000000000&to=1000003600000`)
  })

  it('builds absolute time range from Date objects', () => {
    const from = new Date('2026-06-02T10:00:00Z')
    const to   = new Date('2026-06-02T10:10:00Z')
    const url  = buildGrafanaUrl(BASE, from, to)
    expect(url).toContain(`from=${from.getTime()}`)
    expect(url).toContain(`to=${to.getTime()}`)
  })

  it('mixes relative and absolute', () => {
    const url = buildGrafanaUrl(BASE, 1000000000000, 'now')
    expect(url).toContain('from=1000000000000')
    expect(url).toContain('to=now')
  })

  it('always includes orgId=1', () => {
    expect(buildGrafanaUrl(BASE, 'now-6h', 'now')).toContain('orgId=1')
  })
})

describe('buildRunGrafanaUrl', () => {
  it('subtracts 1 minute from started_at and adds 1 minute to completed_at', () => {
    const { buildRunGrafanaUrl } = require('../grafanaUtils.js')
    const started   = '2026-06-02T10:00:00'   // naive UTC from SQLite
    const completed = '2026-06-02T10:10:00'
    const url = buildRunGrafanaUrl(BASE, started, completed)
    const expectedFrom = new Date('2026-06-02T10:00:00Z').getTime() - 60000
    const expectedTo   = new Date('2026-06-02T10:10:00Z').getTime() + 60000
    expect(url).toContain(`from=${expectedFrom}`)
    expect(url).toContain(`to=${expectedTo}`)
  })

  it('uses to=now when completed_at is null (run still active)', () => {
    const { buildRunGrafanaUrl } = require('../grafanaUtils.js')
    const url = buildRunGrafanaUrl(BASE, '2026-06-02T10:00:00', null)
    expect(url).toContain('to=now')
  })

  it('appends Z to naive datetime strings before parsing', () => {
    const { buildRunGrafanaUrl } = require('../grafanaUtils.js')
    const url = buildRunGrafanaUrl(BASE, '2026-06-02T10:00:00', '2026-06-02T10:10:00')
    // if Z not appended, new Date() may parse as local time — test it produces a valid ms number
    const params = new URLSearchParams(url.split('?')[1])
    expect(Number(params.get('from'))).toBeGreaterThan(0)
    expect(Number(params.get('to'))).toBeGreaterThan(0)
  })
})

describe('buildSweepGrafanaUrl', () => {
  it('spans from first run start minus 1 min to last run end plus 1 min', () => {
    const { buildSweepGrafanaUrl } = require('../grafanaUtils.js')
    const runs = [
      { started_at: '2026-06-02T10:00:00', completed_at: '2026-06-02T10:10:00', status: 'completed' },
      { started_at: '2026-06-02T10:11:00', completed_at: '2026-06-02T10:21:00', status: 'completed' },
    ]
    const url = buildSweepGrafanaUrl(BASE, runs)
    const expectedFrom = new Date('2026-06-02T10:00:00Z').getTime() - 60000
    const expectedTo   = new Date('2026-06-02T10:21:00Z').getTime() + 60000
    expect(url).toContain(`from=${expectedFrom}`)
    expect(url).toContain(`to=${expectedTo}`)
  })

  it('uses to=now when any run is pending or running', () => {
    const { buildSweepGrafanaUrl } = require('../grafanaUtils.js')
    const runs = [
      { started_at: '2026-06-02T10:00:00', completed_at: '2026-06-02T10:10:00', status: 'completed' },
      { started_at: '2026-06-02T10:11:00', completed_at: null, status: 'running' },
    ]
    const url = buildSweepGrafanaUrl(BASE, runs)
    expect(url).toContain('to=now')
  })

  it('returns null when runs array is empty', () => {
    const { buildSweepGrafanaUrl } = require('../grafanaUtils.js')
    expect(buildSweepGrafanaUrl(BASE, [])).toBeNull()
  })

  it('returns null when first run has no started_at', () => {
    const { buildSweepGrafanaUrl } = require('../grafanaUtils.js')
    expect(buildSweepGrafanaUrl(BASE, [{ started_at: null, status: 'pending' }])).toBeNull()
  })
})
```

- [ ] **Step 2: Run tests to confirm they fail**

```bash
cd /Users/cnelson/sandbox/omb_k8s/aws_private/omb-k8s/control-plane/frontend
npm test -- grafanaUtils 2>&1 | tail -15
```

Expected: import errors — `grafanaUtils.js` doesn't exist.

- [ ] **Step 3: Create `control-plane/frontend/src/lib/grafanaUtils.js`**

```js
const DASHBOARD_UID  = 'FejE4c6nz'
const DASHBOARD_SLUG = 'redpanda-ops-dashboard'

function toMs(val) {
  if (typeof val === 'string' && isNaN(Number(val))) return val  // relative like 'now-6h'
  if (val instanceof Date) return val.getTime()
  return val  // already ms number
}

export function buildGrafanaUrl(baseUrl, from, to) {
  const f = toMs(from)
  const t = toMs(to)
  return `${baseUrl}/d/${DASHBOARD_UID}/${DASHBOARD_SLUG}?orgId=1&from=${f}&to=${t}`
}

function parseTs(datetimeStr) {
  if (!datetimeStr) return null
  const s = datetimeStr.endsWith('Z') ? datetimeStr : datetimeStr + 'Z'
  return new Date(s).getTime()
}

export function buildRunGrafanaUrl(baseUrl, startedAt, completedAt) {
  const from = parseTs(startedAt) - 60000
  const to   = completedAt ? parseTs(completedAt) + 60000 : 'now'
  return buildGrafanaUrl(baseUrl, from, to)
}

export function buildSweepGrafanaUrl(baseUrl, runs) {
  if (!runs?.length) return null
  const first = runs[0]
  if (!first.started_at) return null

  const hasActive = runs.some(r => r.status === 'running' || r.status === 'pending')
  const lastCompleted = [...runs].reverse().find(r => r.completed_at)

  const from = parseTs(first.started_at) - 60000
  const to   = hasActive || !lastCompleted ? 'now' : parseTs(lastCompleted.completed_at) + 60000
  return buildGrafanaUrl(baseUrl, from, to)
}
```

- [ ] **Step 4: Run tests to confirm they pass**

```bash
cd /Users/cnelson/sandbox/omb_k8s/aws_private/omb-k8s/control-plane/frontend
npm test -- grafanaUtils 2>&1 | tail -15
```

Expected: all tests pass.

- [ ] **Step 5: Commit**

```bash
cd /Users/cnelson/sandbox/omb_k8s/aws_private/omb-k8s
git add control-plane/frontend/src/lib/grafanaUtils.js \
        control-plane/frontend/src/lib/__tests__/grafanaUtils.test.js
git commit -m "feat: add grafanaUtils with buildGrafanaUrl, buildRunGrafanaUrl, buildSweepGrafanaUrl"
```

---

## Task 3: Frontend — `useGrafanaUrl` hook + `api.js`

**Files:**
- Modify: `control-plane/frontend/src/api.js`
- Create: `control-plane/frontend/src/hooks/useGrafanaUrl.js`

- [ ] **Step 1: Add `getGrafanaUrl` to `api.js`**

In `control-plane/frontend/src/api.js`, append after the existing `getSettings` lines:

```js
export const getGrafanaUrl = () => request('GET', '/grafana/url')
```

- [ ] **Step 2: Create `control-plane/frontend/src/hooks/useGrafanaUrl.js`**

```js
import { useEffect, useState } from 'react'
import { getGrafanaUrl } from '../api.js'

let _cached = undefined  // module-level cache: undefined=not fetched, null=unavailable, string=url

export default function useGrafanaUrl() {
  const [url, setUrl] = useState(_cached !== undefined ? _cached : null)

  useEffect(() => {
    if (_cached !== undefined) {
      setUrl(_cached)
      return
    }
    getGrafanaUrl()
      .then(data => {
        _cached = data.url ?? null
        setUrl(_cached)
      })
      .catch(() => {
        _cached = null
        setUrl(null)
      })
  }, [])

  return url
}
```

- [ ] **Step 3: Run the full frontend test suite to confirm no regressions**

```bash
cd /Users/cnelson/sandbox/omb_k8s/aws_private/omb-k8s/control-plane/frontend
npm test 2>&1 | tail -10
```

Expected: all tests pass.

- [ ] **Step 4: Commit**

```bash
cd /Users/cnelson/sandbox/omb_k8s/aws_private/omb-k8s
git add control-plane/frontend/src/api.js \
        control-plane/frontend/src/hooks/useGrafanaUrl.js
git commit -m "feat: add getGrafanaUrl API call and useGrafanaUrl hook"
```

---

## Task 4: Sidebar — "Monitoring" section

**Files:**
- Modify: `control-plane/frontend/src/components/Layout.jsx`

- [ ] **Step 1: Read the current Layout.jsx**

Read `control-plane/frontend/src/components/Layout.jsx` in full before editing.

- [ ] **Step 2: Add the Monitoring section**

Add the `useGrafanaUrl` import and the Monitoring section. The full updated `Layout.jsx`:

```jsx
import { useState } from 'react'
import { NavLink, Link } from 'react-router-dom'
import WorkerScalingBar from './WorkerScalingBar.jsx'
import { useSettings } from '../context/SettingsContext.jsx'
import useGrafanaUrl from '../hooks/useGrafanaUrl.js'
import { buildGrafanaUrl } from '../lib/grafanaUtils.js'

export default function Layout({ children }) {
  const { hasClusterConfig, settings } = useSettings()
  const [dismissed, setDismissed] = useState(false)
  const grafanaUrl = useGrafanaUrl()

  const showBanner = settings !== undefined && !hasClusterConfig && !dismissed

  return (
    <div className="app-shell">
      <nav className="app-nav">
        <NavLink to="/" className="app-nav-brand">
          OMB <span>Control Plane</span>
        </NavLink>

        <div className="nav-links">
          <NavLink to="/" end className={({ isActive }) => 'nav-link' + (isActive ? ' active' : '')}>
            Benchmark Runs
          </NavLink>
          <NavLink to="/runs/new" className={({ isActive }) => 'nav-link-sub' + (isActive ? ' active' : '')}>
            + New Run
          </NavLink>
          <NavLink to="/sweeps" end className={({ isActive }) => 'nav-link' + (isActive ? ' active' : '')}>
            Sweeps
          </NavLink>
          <NavLink to="/workloads" className={({ isActive }) => 'nav-link' + (isActive ? ' active' : '')}>
            Workload Library
          </NavLink>
        </div>

        <div className="nav-section-divider" />
        <div className="nav-section-label">Infrastructure</div>

        <div className="nav-links">
          <NavLink to="/cluster" className={({ isActive }) => 'nav-link' + (isActive ? ' active' : '')}>
            OMB Cluster
          </NavLink>
          <NavLink to="/settings" className={({ isActive }) => 'nav-link' + (isActive ? ' active' : '')}>
            Settings
          </NavLink>
        </div>

        {grafanaUrl && (
          <>
            <div className="nav-section-divider" />
            <div className="nav-section-label">Monitoring</div>
            <div className="nav-links">
              <a
                href={buildGrafanaUrl(grafanaUrl, 'now-6h', 'now')}
                target="_blank"
                rel="noopener noreferrer"
                className="nav-link"
              >
                Grafana ↗
              </a>
            </div>
          </>
        )}

        <div className="nav-bottom">
          <WorkerScalingBar />
        </div>
      </nav>

      <div className="app-right">
        {showBanner && (
          <div className="setup-banner">
            <span>⚠</span>
            <span>
              Cluster not configured. Add broker address and credentials in{' '}
              <Link to="/settings">Settings</Link> before running benchmarks.
            </span>
            <button className="setup-banner-dismiss" onClick={() => setDismissed(true)} title="Dismiss">
              ×
            </button>
          </div>
        )}
        <main className="app-content">
          {children}
        </main>
      </div>
    </div>
  )
}
```

- [ ] **Step 3: Build to confirm no errors**

```bash
cd /Users/cnelson/sandbox/omb_k8s/aws_private/omb-k8s/control-plane/frontend
npm run build 2>&1 | tail -5
```

Expected: `✓ built in` with no errors.

- [ ] **Step 4: Commit**

```bash
cd /Users/cnelson/sandbox/omb_k8s/aws_private/omb-k8s
git add control-plane/frontend/src/components/Layout.jsx
git commit -m "feat: add Grafana link to sidebar Monitoring section"
```

---

## Task 5: Run Detail page — Grafana link in header

**Files:**
- Modify: `control-plane/frontend/src/pages/RunDetailPage.jsx`

- [ ] **Step 1: Find the run header status badge section**

Search for the status badge area in `RunDetailPage.jsx` — look for the `StatusBadge` render near `run.status` and the `started_at` / `completed_at` display. The target is the `div` that contains both the status badge and the time stamps, around line 488.

- [ ] **Step 2: Add the import lines**

At the top of `RunDetailPage.jsx`, add these two imports alongside the existing ones:

```js
import useGrafanaUrl from '../hooks/useGrafanaUrl.js'
import { buildRunGrafanaUrl } from '../lib/grafanaUtils.js'
```

- [ ] **Step 3: Add the hook call**

Inside the `RunDetailPage` component function, alongside the other hook calls near the top:

```js
const grafanaUrl = useGrafanaUrl()
```

- [ ] **Step 4: Add the link in the header**

Find the section that renders the status badge and timestamps in the page header. It looks like:

```jsx
{run.started_at && (
  <span className="text-muted text-small">
    Started {new Date(...).toLocaleString()}
  </span>
)}
{run.completed_at && (
  <span className="text-muted text-small">
    Completed {new Date(...).toLocaleString()}
  </span>
)}
```

After the status badge / time display block, add the Grafana link. Locate the element that wraps the status badge (it will be something like `<div className="flex items-center gap-8 mt-4">`) and append:

```jsx
{grafanaUrl && run.started_at && (
  <a
    href={buildRunGrafanaUrl(grafanaUrl, run.started_at, run.completed_at)}
    target="_blank"
    rel="noopener noreferrer"
    className="badge"
    style={{ textDecoration: 'none', background: 'rgba(249,115,22,0.15)', color: '#f97316', border: '1px solid rgba(249,115,22,0.3)' }}
  >
    📊 Grafana ↗
  </a>
)}
```

- [ ] **Step 5: Build to confirm no errors**

```bash
cd /Users/cnelson/sandbox/omb_k8s/aws_private/omb-k8s/control-plane/frontend
npm run build 2>&1 | tail -5
```

Expected: `✓ built in` with no errors.

- [ ] **Step 6: Commit**

```bash
cd /Users/cnelson/sandbox/omb_k8s/aws_private/omb-k8s
git add control-plane/frontend/src/pages/RunDetailPage.jsx
git commit -m "feat: add Grafana deep-link in run detail header"
```

---

## Task 6: Sweep Detail page — Grafana link above comparison table

**Files:**
- Modify: `control-plane/frontend/src/pages/SweepDetailPage.jsx`

- [ ] **Step 1: Add the import lines**

At the top of `SweepDetailPage.jsx`, add alongside existing imports:

```js
import useGrafanaUrl from '../hooks/useGrafanaUrl.js'
import { buildSweepGrafanaUrl } from '../lib/grafanaUtils.js'
```

- [ ] **Step 2: Add the hook call**

Inside `SweepDetailPage`, alongside other state declarations:

```js
const grafanaUrl = useGrafanaUrl()
```

- [ ] **Step 3: Add the link above the comparison table**

Find the `card-header` div that contains the `<h3>Run Comparison — ...</h3>` (line 92–93). Replace it with:

```jsx
<div className="card-header" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
  <h3>Run Comparison — {runs.length} run{runs.length !== 1 ? 's' : ''}</h3>
  {grafanaUrl && buildSweepGrafanaUrl(grafanaUrl, runs) && (
    <a
      href={buildSweepGrafanaUrl(grafanaUrl, runs)}
      target="_blank"
      rel="noopener noreferrer"
      className="badge"
      style={{ textDecoration: 'none', background: 'rgba(249,115,22,0.15)', color: '#f97316', border: '1px solid rgba(249,115,22,0.3)' }}
    >
      📊 Full sweep in Grafana ↗
    </a>
  )}
</div>
```

- [ ] **Step 4: Build to confirm no errors**

```bash
cd /Users/cnelson/sandbox/omb_k8s/aws_private/omb-k8s/control-plane/frontend
npm run build 2>&1 | tail -5
```

Expected: `✓ built in` with no errors.

- [ ] **Step 5: Run the full test suite**

```bash
npm test 2>&1 | tail -10
```

Expected: all tests pass.

- [ ] **Step 6: Commit**

```bash
cd /Users/cnelson/sandbox/omb_k8s/aws_private/omb-k8s
git add control-plane/frontend/src/pages/SweepDetailPage.jsx
git commit -m "feat: add Grafana deep-link above sweep comparison table"
```

---

## Self-Review

**Spec coverage:**

| Requirement | Task |
|---|---|
| Sidebar "Monitoring" section with Grafana link, 6h range | Task 4 |
| Grafana link in run header, run time window ±1 min | Task 5 |
| Grafana link above sweep comparison table, full sweep span ±1 min | Task 6 |
| Links hidden when Grafana URL unavailable | All — `grafanaUrl &&` guards |
| Backend auto-discovers Grafana LoadBalancer address | Task 1 |
| Frontend fetches URL once, cached across components | Task 3 `useGrafanaUrl` module cache |
| All links open in new tab | Tasks 4, 5, 6 — `target="_blank"` |
| Absolute time ranges for run/sweep, relative for sidebar | Tasks 2, 4, 5, 6 |
| `to=now` when run/sweep still active | Task 2 `buildRunGrafanaUrl` / `buildSweepGrafanaUrl` |

**Placeholder scan:** None found. All steps contain complete code.

**Type consistency:**
- `buildGrafanaUrl(baseUrl, from, to)` — used consistently in Tasks 2, 4, 5, 6
- `buildRunGrafanaUrl(baseUrl, startedAt, completedAt)` — defined Task 2, used Task 5
- `buildSweepGrafanaUrl(baseUrl, runs)` — defined Task 2, used Task 6
- `useGrafanaUrl()` returns `string | null` — hook defined Task 3, consumed Tasks 4, 5, 6
- All Grafana link `<a>` elements use same inline style for visual consistency
