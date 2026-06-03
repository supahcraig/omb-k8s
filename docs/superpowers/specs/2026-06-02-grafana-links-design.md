# Grafana Deep-Link Integration

**Date:** 2026-06-02
**Status:** Approved

## Summary

Add Grafana deep-links to the OMB control plane UI so SEs can jump from any benchmark context directly into the Redpanda Ops Dashboard in Grafana, pre-scoped to the relevant time window.

---

## Requirements

1. **Sidebar nav** — A "Monitoring" section below Infrastructure containing a "Grafana" link that opens the Redpanda dashboard with the last 6 hours selected.
2. **Run Detail page** — A Grafana link in the run header (next to the status badge) that opens the dashboard scoped to the run's time window ±1 minute.
3. **Sweep Detail page** — A Grafana link above the run comparison table that opens the dashboard scoped to the full sweep span (first run start → last run end) ±1 minute.

All links open in a new tab. All links are hidden when the Grafana URL is unavailable.

---

## Architecture

### Backend — `GET /api/grafana/url`

New file: `control-plane/routers/grafana.py`

Reads the `omb-grafana` k8s Service from the current namespace using the existing in-cluster k8s client. Extracts `status.loadBalancer.ingress[0].hostname` (AWS) or `status.loadBalancer.ingress[0].ip` (GCP/Azure). Returns:

```json
{ "url": "http://<address>" }
```

Returns `{ "url": null }` when:
- The service is not type LoadBalancer
- The ingress address is not yet assigned
- Any k8s error occurs (e.g., local dev without a cluster)

The endpoint never errors — it always returns 200 with either a URL or null. Registered in `main.py` at `/api/grafana`.

### Frontend — `useGrafanaUrl()` hook

File: `control-plane/frontend/src/hooks/useGrafanaUrl.js`

Fetches `GET /api/grafana/url` once on first call. Caches the result in module-level state so all consumers share a single network request per page load. Returns `null` while loading or when the URL is unavailable. Consumers render nothing when `null` is returned.

### Frontend — `buildGrafanaUrl(baseUrl, from, to)`

File: `control-plane/frontend/src/lib/grafanaUtils.js`

Constructs the full Grafana deep-link URL.

- **`baseUrl`**: the host URL returned by `useGrafanaUrl()`
- **`from`**: either a Grafana-native relative string (`"now-6h"`) or a Unix timestamp in milliseconds
- **`to`**: same — relative string or milliseconds

Dashboard UID is hardcoded as `FejE4c6nz` (from the bundled `redpanda.json`). Always includes `orgId=1`.

Output example:
```
http://a3febc43.us-east-2.elb.amazonaws.com/d/FejE4c6nz/redpanda-ops-dashboard?orgId=1&from=1748865120000&to=1748865780000
```

### `api.js`

Add `export const getGrafanaUrl = () => request('GET', '/grafana/url')`.

---

## Link Specifications

### Sidebar (`Layout.jsx`)

- New section below the Infrastructure divider, labeled `MONITORING`
- Single link: `Grafana ↗`
- Time range: `from=now-6h&to=now` (Grafana relative — always current)
- Rendered as a plain `<a href={url} target="_blank">` styled to match existing `nav-link` class
- Hidden when `useGrafanaUrl()` returns null (entire Monitoring section hidden)

### Run Detail (`RunDetailPage.jsx`)

- Rendered in the run page header, to the right of the status badge
- Label: `📊 Grafana ↗`
- Time range: `from` = `run.started_at` minus 60 seconds (ms), `to` = `run.completed_at` plus 60 seconds (ms)
- When run is still in `running` status: `to = "now"` (Grafana relative)
- When `run.started_at` is null (run hasn't started): link not rendered
- Hidden when `useGrafanaUrl()` returns null

### Sweep Detail (`SweepDetailPage.jsx`)

- Rendered above the run comparison table, inline with the section header (right-aligned)
- Label: `📊 Full sweep in Grafana ↗`
- Time range:
  - `from` = `started_at` of the first run in the sweep minus 60 seconds (ms)
  - `to` = `completed_at` of the last completed run in the sweep plus 60 seconds (ms)
  - When any run is still `running` or `pending`: `to = "now"`
- When `runs` array is empty or first run has no `started_at`: link not rendered
- Hidden when `useGrafanaUrl()` returns null

---

## File Map

**New files:**
- `control-plane/routers/grafana.py`
- `control-plane/frontend/src/hooks/useGrafanaUrl.js`
- `control-plane/frontend/src/lib/grafanaUtils.js`

**Modified files:**
- `control-plane/main.py` — register grafana router at `/api/grafana`
- `control-plane/frontend/src/api.js` — add `getGrafanaUrl`
- `control-plane/frontend/src/components/Layout.jsx` — add Monitoring section
- `control-plane/frontend/src/pages/RunDetailPage.jsx` — add header link
- `control-plane/frontend/src/pages/SweepDetailPage.jsx` — add table header link

---

## Error Handling

- **Grafana not deployed / no LoadBalancer:** `/api/grafana/url` returns `{ url: null }`. All links hidden. No errors shown to the user.
- **Address pending (LB provisioning):** Same as above — null returned, links hidden.
- **k8s unreachable (local dev):** Exception caught, null returned, links hidden.
- **Run with no `started_at`:** Link not rendered (guards in JSX before calling `buildGrafanaUrl`).
- **Sweep with no runs:** Link not rendered.

---

## Out of Scope

- Grafana authentication passthrough (SE logs in manually)
- Per-panel deep links
- Grafana URL configuration in Settings (URL is auto-discovered)
- Any changes to the Grafana dashboard itself
