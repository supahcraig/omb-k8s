# UI: Dark Theme, YAML Preview Fix, and Live Results Charts — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Migrate the frontend to a Slate dark theme, fix YAML preview sizing on the New Run page, and add live-updating Recharts charts on the Run Detail page with OMB/Redpanda source badges.

**Architecture:** Three independent frontend-only changes. Dark theme remaps CSS variables and hardcoded surface colors in `index.css`. YAML fix adds `width:100%` to `<details>` elements and enables bidirectional resize. Charts add a new `RunCharts` component (Recharts) fed by a `parseLiveMetric` utility that extracts per-second stats from WebSocket log lines during a run, transitioning to stored `throughput_timeseries` / `backlog_timeseries` JSON from SQLite on completion.

**Tech Stack:** React 18, Vite 5, Recharts, Vitest (unit tests for pure functions only), FastAPI backend unchanged.

---

## File Map

**New files:**
- `control-plane/frontend/src/lib/ombLogParser.js` — `parseLiveMetric(line, sampleIndex)` pure function
- `control-plane/frontend/src/lib/chartDataUtils.js` — `normalizeTimeseries(metricsOut, messageSize)` + `promToChartData(samples)`
- `control-plane/frontend/src/lib/__tests__/ombLogParser.test.js`
- `control-plane/frontend/src/lib/__tests__/chartDataUtils.test.js`
- `control-plane/frontend/src/components/RunCharts.jsx`

**Modified files:**
- `control-plane/frontend/package.json` — add recharts, vitest, jsdom, @vitest/ui, @testing-library/react
- `control-plane/frontend/vite.config.js` — add `test` block
- `control-plane/frontend/src/index.css` — dark theme vars + secondary surfaces + `.source-badge` classes
- `control-plane/frontend/src/components/DriverForm.jsx` — `<details>` width fix
- `control-plane/frontend/src/components/WorkloadForm.jsx` — `<details>` width fix
- `control-plane/frontend/src/pages/RunDetailPage.jsx` — wire RunCharts, live parsing, remove old SVG LineChart

---

## Task 1: Install dependencies and configure Vitest

**Files:**
- Modify: `control-plane/frontend/package.json`
- Modify: `control-plane/frontend/vite.config.js`

- [ ] **Step 1: Install recharts and test tooling**

```bash
cd control-plane/frontend
npm install recharts
npm install --save-dev vitest jsdom @vitest/ui @testing-library/react @testing-library/jest-dom
```

- [ ] **Step 2: Add test script to package.json**

In `package.json`, replace the `"scripts"` block with:

```json
"scripts": {
  "dev": "vite",
  "build": "vite build",
  "preview": "vite preview",
  "test": "vitest run",
  "test:watch": "vitest"
},
```

- [ ] **Step 3: Add Vitest config to vite.config.js**

Replace the entire `vite.config.js` with:

```js
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  build: {
    outDir: 'build',
  },
  server: {
    proxy: {
      '/api': 'http://localhost:8000',
      '/ws': { target: 'ws://localhost:8000', ws: true },
    },
  },
  test: {
    environment: 'jsdom',
    globals: true,
    setupFiles: [],
  },
})
```

- [ ] **Step 4: Verify test runner works**

```bash
cd control-plane/frontend
npm test
```

Expected: `No test files found` (or 0 tests pass) — not an error, just no tests yet.

- [ ] **Step 5: Verify build still passes**

```bash
npm run build
```

Expected: Build completes with no errors. Output in `build/`.

- [ ] **Step 6: Commit**

```bash
git add control-plane/frontend/package.json control-plane/frontend/package-lock.json control-plane/frontend/vite.config.js
git commit -m "feat: add recharts and vitest to frontend"
```

---

## Task 2: Dark theme — CSS variables and primary colors

**Files:**
- Modify: `control-plane/frontend/src/index.css`

- [ ] **Step 1: Replace the `:root` block**

Find the `:root { ... }` block (lines 7–25) and replace it entirely:

```css
:root {
  --color-bg: #0f1117;
  --color-surface: #171c28;
  --color-border: #2a3045;
  --color-primary: #e63946;
  --color-primary-dark: #c62233;
  --color-text: #e8edf8;
  --color-text-muted: #7a8399;
  --color-success: #4ade80;
  --color-warning: #fbbf24;
  --color-error: #f87171;
  --color-nav-bg: #1a1a2e;
  --color-nav-text: #e8eaf0;
  --color-nav-hover: #2d2d4a;
  --color-nav-active: #e63946;
  --radius: 6px;
  --shadow: 0 1px 3px rgba(0,0,0,0.4), 0 1px 2px rgba(0,0,0,0.3);
  --shadow-md: 0 4px 6px rgba(0,0,0,0.3), 0 2px 4px rgba(0,0,0,0.2);
}
```

- [ ] **Step 2: Update status badge colors**

Find and replace the badge rules:

```css
.badge-running   { background: rgba(29,78,216,0.2);   color: #60a5fa; }
.badge-completed { background: rgba(21,128,61,0.2);    color: #4ade80; }
.badge-failed    { background: rgba(185,28,28,0.2);    color: #f87171; }
.badge-pending   { background: rgba(107,114,128,0.15); color: #9ca3af; }
.badge-cancelled { background: rgba(133,77,14,0.2);    color: #fbbf24; }
```

- [ ] **Step 3: Update alert colors**

Find and replace the alert rules:

```css
.alert-warning {
  background: rgba(251,191,36,0.08);
  border: 1px solid rgba(251,191,36,0.3);
  color: #fbbf24;
}

.alert-error {
  background: rgba(248,113,113,0.08);
  border: 1px solid rgba(248,113,113,0.3);
  color: #f87171;
}

.alert-success {
  background: rgba(74,222,128,0.08);
  border: 1px solid rgba(74,222,128,0.3);
  color: #4ade80;
}

.alert-info {
  background: rgba(96,165,250,0.08);
  border: 1px solid rgba(96,165,250,0.3);
  color: #60a5fa;
}
```

- [ ] **Step 4: Commit**

```bash
git add control-plane/frontend/src/index.css
git commit -m "feat: dark theme CSS variables and badge/alert colors"
```

---

## Task 3: Dark theme — secondary surfaces and component colors

**Files:**
- Modify: `control-plane/frontend/src/index.css`

- [ ] **Step 1: Update table colors**

Find and replace the `.data-table` rules:

```css
.data-table th {
  text-align: left;
  padding: 10px 16px;
  background: #131929;
  border-bottom: 1px solid var(--color-border);
  font-weight: 600;
  font-size: 12px;
  text-transform: uppercase;
  letter-spacing: 0.04em;
  color: var(--color-text-muted);
  white-space: nowrap;
}

.data-table td {
  padding: 10px 16px;
  border-bottom: 1px solid #1e2640;
  vertical-align: middle;
}

.data-table tr:last-child td {
  border-bottom: none;
}

.data-table tr:hover td {
  background: rgba(255,255,255,0.03);
}
```

- [ ] **Step 2: Update button secondary/danger/ghost hover**

Find and replace:

```css
.btn-secondary:hover:not(:disabled) {
  background: rgba(255,255,255,0.06);
}

.btn-danger {
  background: transparent;
  color: var(--color-error);
  border-color: var(--color-error);
}

.btn-danger:hover:not(:disabled) {
  background: rgba(248,113,113,0.08);
}

.btn-ghost:hover:not(:disabled) {
  background: rgba(230,57,70,0.1);
}
```

- [ ] **Step 3: Update mode-tabs**

Find and replace:

```css
.mode-tabs {
  display: flex;
  gap: 0;
  background: rgba(255,255,255,0.05);
  border-radius: var(--radius);
  padding: 3px;
  margin-bottom: 20px;
  width: fit-content;
}

.mode-tab.active {
  background: var(--color-surface);
  color: var(--color-text);
  box-shadow: var(--shadow);
}
```

- [ ] **Step 4: Update section-label, inline-editor, workload-tag**

Find and replace each:

```css
.section-label {
  font-size: 11px;
  font-weight: 700;
  text-transform: uppercase;
  letter-spacing: 0.08em;
  color: var(--color-text-muted);
  padding: 12px 16px 8px;
  background: #131929;
  border-bottom: 1px solid var(--color-border);
}
```

```css
.inline-editor {
  padding: 16px;
  border-bottom: 1px solid var(--color-border);
  background: #141c2e;
}
```

```css
.workload-tag {
  background: rgba(255,255,255,0.06);
  color: var(--color-text-muted);
  padding: 2px 8px;
  border-radius: 10px;
  font-size: 11px;
  font-weight: 500;
}
```

- [ ] **Step 5: Update password-display, connection-box, projected-load, setup-banner**

```css
.password-display {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 7px 10px;
  border: 1px solid var(--color-border);
  border-radius: var(--radius);
  background: #131929;
}
```

```css
.connection-box {
  background: #131929;
  border: 1px solid var(--color-border);
  border-radius: var(--radius);
  padding: 12px 14px;
  margin-bottom: 16px;
}
```

```css
.projected-load {
  background: rgba(74,222,128,0.06);
  border: 1px solid rgba(74,222,128,0.2);
  border-radius: var(--radius);
  padding: 10px 14px;
  margin-bottom: 16px;
  font-size: 13px;
}

.projected-load-title {
  font-weight: 700;
  margin-bottom: 4px;
  font-size: 12px;
  text-transform: uppercase;
  letter-spacing: 0.06em;
  color: #4ade80;
}

.projected-load-grid {
  display: grid;
  grid-template-columns: 80px 1fr 1fr;
  gap: 4px 16px;
  color: #86efac;
}
```

```css
.setup-banner {
  background: rgba(251,191,36,0.08);
  border-bottom: 1px solid rgba(251,191,36,0.3);
  padding: 10px 24px;
  display: flex;
  align-items: center;
  gap: 12px;
  font-size: 13px;
  color: #fbbf24;
}

.setup-banner a {
  color: var(--color-primary);
  font-weight: 600;
  text-decoration: none;
  white-space: nowrap;
}

.setup-banner-dismiss {
  margin-left: auto;
  background: none;
  border: none;
  cursor: pointer;
  color: #fbbf24;
  font-size: 16px;
  line-height: 1;
  padding: 0 4px;
}
```

- [ ] **Step 6: Update test-result boxes**

```css
.test-result.success {
  background: rgba(74,222,128,0.08);
  border: 1px solid rgba(74,222,128,0.3);
  color: #4ade80;
}

.test-result.error {
  background: rgba(248,113,113,0.08);
  border: 1px solid rgba(248,113,113,0.3);
  color: #f87171;
}
```

- [ ] **Step 7: Update the second `.section-label` rule (the one in the form layout helpers section)**

The CSS has a duplicate `.section-label` starting around line 886. Replace it with:

```css
.section-label {
  margin-bottom: 8px;
  font-size: 12px;
  font-weight: 700;
  text-transform: uppercase;
  letter-spacing: 0.06em;
  color: var(--color-text-muted);
}
```

- [ ] **Step 8: Add `.source-badge` classes (new — append to end of file)**

```css
/* ── Source badges (chart titles) ──────────────────── */

.source-badge {
  font-size: 10px;
  font-weight: 500;
  padding: 1px 6px;
  border-radius: 4px;
  text-transform: uppercase;
  letter-spacing: 0.06em;
}

.source-badge-omb {
  background: rgba(51,65,85,0.6);
  color: #64748b;
  border: 1px solid #334155;
}

.source-badge-redpanda {
  background: rgba(127,29,29,0.4);
  color: #f87171;
  border: 1px solid rgba(153,27,27,0.6);
}
```

- [ ] **Step 9: Start dev server and visually verify all pages**

```bash
cd control-plane/frontend && npm run dev
```

Open http://localhost:5173 and check each page: Runs, Run Detail, Workload Library, Settings, Sweeps. Look for any remaining white/light surfaces. The nav should be unchanged. Cards, tables, forms, and alerts should all be dark.

- [ ] **Step 10: Commit**

```bash
git add control-plane/frontend/src/index.css
git commit -m "feat: dark theme secondary surfaces, source badge classes"
```

---

## Task 4: YAML preview fix

**Files:**
- Modify: `control-plane/frontend/src/components/DriverForm.jsx`
- Modify: `control-plane/frontend/src/components/WorkloadForm.jsx`
- Modify: `control-plane/frontend/src/index.css`

- [ ] **Step 1: Fix `.form-textarea` resize in index.css**

Find:
```css
.form-textarea {
  resize: vertical;
```

Replace with:
```css
.form-textarea {
  resize: both;
```

- [ ] **Step 2: Fix DriverForm `<details>` width**

In `DriverForm.jsx`, find:

```jsx
      <details open>
        <summary style={{ cursor: 'pointer', fontSize: 13, fontWeight: 600, marginBottom: 8, userSelect: 'none' }}>
```

Replace with:

```jsx
      <details open style={{ width: '100%' }}>
        <summary style={{ cursor: 'pointer', fontSize: 13, fontWeight: 600, marginBottom: 8, userSelect: 'none' }}>
```

- [ ] **Step 3: Fix WorkloadForm `<details>` width**

In `WorkloadForm.jsx`, find the identical `<details open>` pattern and apply the same fix:

```jsx
      <details open style={{ width: '100%' }}>
        <summary style={{ cursor: 'pointer', fontSize: 13, fontWeight: 600, marginBottom: 8, userSelect: 'none' }}>
```

- [ ] **Step 4: Verify visually**

Open the New Run page (click "+ New Run"). The YAML preview textareas in the Driver and Workload columns should fill the full column width. Drag the bottom-right corner of a textarea — it should resize in both dimensions.

- [ ] **Step 5: Commit**

```bash
git add control-plane/frontend/src/index.css \
        control-plane/frontend/src/components/DriverForm.jsx \
        control-plane/frontend/src/components/WorkloadForm.jsx
git commit -m "fix: YAML preview fills column width, resizable in both dimensions"
```

---

## Task 5: OMB log parser utility (TDD)

**Files:**
- Create: `control-plane/frontend/src/lib/ombLogParser.js`
- Create: `control-plane/frontend/src/lib/__tests__/ombLogParser.test.js`

- [ ] **Step 1: Create the test file**

```bash
mkdir -p control-plane/frontend/src/lib/__tests__
```

Create `control-plane/frontend/src/lib/__tests__/ombLogParser.test.js`:

```js
import { describe, it, expect } from 'vitest'
import { parseLiveMetric } from '../ombLogParser.js'

describe('parseLiveMetric', () => {
  it('returns null for non-stat lines', () => {
    expect(parseLiveMetric('INFO Starting benchmark worker', 0)).toBeNull()
    expect(parseLiveMetric('', 0)).toBeNull()
    expect(parseLiveMetric('{"publishRate":[98000]}', 0)).toBeNull()
  })

  it('parses publish rate msg/s and MB/s', () => {
    const line = 'Running - Pub rate: 98,412.3 msg/s / 96.1 MB/s | Cons rate: 97,881.2 msg/s / 95.6 MB/s | Backlog: 0 K msgs'
    const result = parseLiveMetric(line, 3)
    expect(result).not.toBeNull()
    expect(result.t).toBe(3)
    expect(result.pubMsgSec).toBeCloseTo(98412.3)
    expect(result.pubMBSec).toBeCloseTo(96.1)
    expect(result.consMsgSec).toBeCloseTo(97881.2)
    expect(result.consMBSec).toBeCloseTo(95.6)
    expect(result.backlog).toBe(0)
  })

  it('parses publish and E2E latency p99', () => {
    const line = 'Pub rate: 1,000 msg/s / 1.0 MB/s | Cons rate: 999 msg/s / 0.9 MB/s | Backlog: 5 K msgs | Pub Latency (ms) avg: 8.2 - 50%: 7.4 - 99%: 15.2 - 99.9%: 22.4 | E2E Latency (ms) avg: 11.3 - 50%: 10.1 - 99%: 18.6'
    const result = parseLiveMetric(line, 10)
    expect(result.pubP99).toBeCloseTo(15.2)
    expect(result.e2eP99).toBeCloseTo(18.6)
  })

  it('returns null pubP99 and e2eP99 when latency section absent', () => {
    const line = 'Pub rate: 1,000 msg/s / 1.0 MB/s | Cons rate: 999 msg/s / 0.9 MB/s | Backlog: 0 K msgs'
    const result = parseLiveMetric(line, 1)
    expect(result.pubP99).toBeNull()
    expect(result.e2eP99).toBeNull()
  })

  it('handles comma-separated thousands in numbers', () => {
    const line = 'Pub rate: 1,234,567.8 msg/s / 1,200.5 MB/s | Cons rate: 1,234,000 msg/s / 1,199.0 MB/s | Backlog: 12,345 K msgs'
    const result = parseLiveMetric(line, 0)
    expect(result.pubMsgSec).toBeCloseTo(1234567.8)
    expect(result.backlog).toBeCloseTo(12345)
  })
})
```

- [ ] **Step 2: Run tests to confirm they fail**

```bash
cd control-plane/frontend && npm test
```

Expected: Fails with `Cannot find module '../ombLogParser.js'`

- [ ] **Step 3: Create the implementation**

Create `control-plane/frontend/src/lib/ombLogParser.js`:

```js
const PUB_RE   = /Pub rate:\s*([\d,.]+)\s*msg\/s\s*\/\s*([\d,.]+)\s*MB\/s/
const CONS_RE  = /Cons rate:\s*([\d,.]+)\s*msg\/s\s*\/\s*([\d,.]+)\s*MB\/s/
const BACK_RE  = /Backlog:\s*([\d,.]+)/
// Matches first 99% after "Pub Latency" (stops at pipe or end)
const PUB_P99_RE = /Pub Latency[^|]*?99%:\s*([\d,.]+)/
// Matches first 99% after "E2E Latency"
const E2E_P99_RE = /E2E Latency[^|]*?99%:\s*([\d,.]+)/

const num = s => parseFloat(s.replace(/,/g, ''))

/**
 * Parse one OMB periodic stat log line.
 * Returns a LivePoint object, or null if the line is not a stat line.
 * sampleIndex is used as the t value (elapsed seconds, one per matched line).
 */
export function parseLiveMetric(line, sampleIndex) {
  const pubMatch = PUB_RE.exec(line)
  if (!pubMatch) return null

  const consMatch  = CONS_RE.exec(line)
  const backMatch  = BACK_RE.exec(line)
  const pubP99Match = PUB_P99_RE.exec(line)
  const e2eP99Match = E2E_P99_RE.exec(line)

  return {
    t:          sampleIndex,
    pubMsgSec:  num(pubMatch[1]),
    pubMBSec:   num(pubMatch[2]),
    consMsgSec: consMatch ? num(consMatch[1]) : null,
    consMBSec:  consMatch ? num(consMatch[2]) : null,
    backlog:    backMatch ? num(backMatch[1]) : null,
    pubP99:     pubP99Match ? num(pubP99Match[1]) : null,
    e2eP99:     e2eP99Match ? num(e2eP99Match[1]) : null,
  }
}
```

- [ ] **Step 4: Run tests to confirm they pass**

```bash
cd control-plane/frontend && npm test
```

Expected: All 5 tests in `ombLogParser.test.js` pass.

- [ ] **Step 5: Commit**

```bash
git add control-plane/frontend/src/lib/ombLogParser.js \
        control-plane/frontend/src/lib/__tests__/ombLogParser.test.js
git commit -m "feat: OMB log line parser with unit tests"
```

---

## Task 6: Chart data normalization utilities (TDD)

**Files:**
- Create: `control-plane/frontend/src/lib/chartDataUtils.js`
- Create: `control-plane/frontend/src/lib/__tests__/chartDataUtils.test.js`

- [ ] **Step 1: Create the test file**

Create `control-plane/frontend/src/lib/__tests__/chartDataUtils.test.js`:

```js
import { describe, it, expect } from 'vitest'
import { normalizeTimeseries, promToChartData } from '../chartDataUtils.js'

describe('normalizeTimeseries', () => {
  it('returns empty array for null input', () => {
    expect(normalizeTimeseries(null, 1024)).toEqual([])
    expect(normalizeTimeseries(undefined, 1024)).toEqual([])
  })

  it('returns empty array when throughput_timeseries is missing', () => {
    expect(normalizeTimeseries({ backlog_timeseries: null }, 1024)).toEqual([])
  })

  it('maps publish/consume rate arrays to chart points', () => {
    const metricsOut = {
      throughput_timeseries: JSON.stringify({
        publish_rate: [1000, 1100, 1200],
        consume_rate: [990, 1090, 1190],
        sample_rate_ms: 1000,
      }),
      backlog_timeseries: JSON.stringify({ backlog: [50, 25, 0], sample_rate_ms: 1000 }),
    }
    const result = normalizeTimeseries(metricsOut, 1024)
    expect(result).toHaveLength(3)
    expect(result[0].t).toBe(0)
    expect(result[1].t).toBe(1)
    expect(result[2].t).toBe(2)
    expect(result[0].pubMsgSec).toBe(1000)
    expect(result[0].consMsgSec).toBe(990)
    expect(result[0].backlog).toBe(50)
    expect(result[2].backlog).toBe(0)
  })

  it('computes MB/s from messageSize', () => {
    const metricsOut = {
      throughput_timeseries: JSON.stringify({
        publish_rate: [1000],
        consume_rate: [990],
        sample_rate_ms: 1000,
      }),
      backlog_timeseries: null,
    }
    const result = normalizeTimeseries(metricsOut, 1024)
    expect(result[0].pubMBSec).toBeCloseTo(1000 * 1024 / 1_048_576)
    expect(result[0].consMBSec).toBeCloseTo(990 * 1024 / 1_048_576)
  })

  it('sets MB/s to null when messageSize is 0', () => {
    const metricsOut = {
      throughput_timeseries: JSON.stringify({ publish_rate: [1000], consume_rate: [990], sample_rate_ms: 1000 }),
      backlog_timeseries: null,
    }
    const result = normalizeTimeseries(metricsOut, 0)
    expect(result[0].pubMBSec).toBeNull()
    expect(result[0].consMBSec).toBeNull()
  })

  it('handles missing backlog gracefully', () => {
    const metricsOut = {
      throughput_timeseries: JSON.stringify({ publish_rate: [1000], consume_rate: [990], sample_rate_ms: 1000 }),
      backlog_timeseries: null,
    }
    const result = normalizeTimeseries(metricsOut, 1024)
    expect(result[0].backlog).toBeNull()
  })

  it('handles malformed JSON without throwing', () => {
    const metricsOut = { throughput_timeseries: 'not json' }
    expect(() => normalizeTimeseries(metricsOut, 1024)).not.toThrow()
    expect(normalizeTimeseries(metricsOut, 1024)).toEqual([])
  })

  it('uses sample_rate_ms for t values when > 1000ms', () => {
    const metricsOut = {
      throughput_timeseries: JSON.stringify({
        publish_rate: [1000, 1100],
        consume_rate: [990, 1090],
        sample_rate_ms: 2000,
      }),
      backlog_timeseries: null,
    }
    const result = normalizeTimeseries(metricsOut, 1024)
    expect(result[0].t).toBe(0)
    expect(result[1].t).toBe(2)
  })
})

describe('promToChartData', () => {
  it('returns empty array for null/empty input', () => {
    expect(promToChartData(null)).toEqual([])
    expect(promToChartData([])).toEqual([])
  })

  it('converts bytes to MB/s and passes through recordsPerSec', () => {
    const samples = [
      { t: 0, bytes_in_per_sec: 1_048_576, bytes_out_per_sec: 524_288, records_per_sec: 1000 },
      { t: 1, bytes_in_per_sec: 2_097_152, bytes_out_per_sec: 1_048_576, records_per_sec: 2000 },
    ]
    const result = promToChartData(samples)
    expect(result).toHaveLength(2)
    expect(result[0]).toMatchObject({ t: 0, bytesInMBSec: 1.0, bytesOutMBSec: 0.5, recordsPerSec: 1000 })
    expect(result[1].bytesInMBSec).toBeCloseTo(2.0)
  })

  it('passes null through for missing values', () => {
    const samples = [{ t: 0, bytes_in_per_sec: null, bytes_out_per_sec: null, records_per_sec: null }]
    const result = promToChartData(samples)
    expect(result[0].bytesInMBSec).toBeNull()
    expect(result[0].recordsPerSec).toBeNull()
  })
})
```

- [ ] **Step 2: Run tests to confirm they fail**

```bash
cd control-plane/frontend && npm test
```

Expected: Fails with `Cannot find module '../chartDataUtils.js'`

- [ ] **Step 3: Create the implementation**

Create `control-plane/frontend/src/lib/chartDataUtils.js`:

```js
/**
 * Convert a MetricsOut object (from SQLite) into a Recharts-compatible
 * array of chart points. metricsOut.throughput_timeseries and
 * backlog_timeseries are JSON strings stored in the DB.
 */
export function normalizeTimeseries(metricsOut, messageSize) {
  if (!metricsOut?.throughput_timeseries) return []

  let throughput
  try {
    throughput = JSON.parse(metricsOut.throughput_timeseries)
  } catch {
    return []
  }

  let backlogArr = null
  if (metricsOut.backlog_timeseries) {
    try {
      const b = JSON.parse(metricsOut.backlog_timeseries)
      backlogArr = b.backlog ?? null
    } catch { /* leave null */ }
  }

  const sampleMs = throughput.sample_rate_ms || 1000
  const bytesPerMsg = messageSize || 0

  return (throughput.publish_rate || []).map((pubMsgSec, i) => {
    const consMsgSec = throughput.consume_rate?.[i] ?? null
    return {
      t: Math.round((i * sampleMs) / 1000),
      pubMsgSec,
      consMsgSec,
      pubMBSec:  bytesPerMsg > 0 ? pubMsgSec * bytesPerMsg / 1_048_576 : null,
      consMBSec: bytesPerMsg > 0 && consMsgSec != null
        ? consMsgSec * bytesPerMsg / 1_048_576 : null,
      backlog:   backlogArr ? (backlogArr[i] ?? null) : null,
      pubP99:    null,
      e2eP99:    null,
    }
  })
}

/**
 * Convert raw PrometheusSample rows into Recharts-compatible chart points.
 */
export function promToChartData(samples) {
  return (samples || []).map(s => ({
    t:            s.t,
    bytesInMBSec:  s.bytes_in_per_sec  != null ? s.bytes_in_per_sec  / 1_048_576 : null,
    bytesOutMBSec: s.bytes_out_per_sec != null ? s.bytes_out_per_sec / 1_048_576 : null,
    recordsPerSec: s.records_per_sec   ?? null,
  }))
}
```

- [ ] **Step 4: Run all tests and confirm they pass**

```bash
cd control-plane/frontend && npm test
```

Expected: All tests in both `ombLogParser.test.js` and `chartDataUtils.test.js` pass.

- [ ] **Step 5: Commit**

```bash
git add control-plane/frontend/src/lib/chartDataUtils.js \
        control-plane/frontend/src/lib/__tests__/chartDataUtils.test.js
git commit -m "feat: chart data normalization utilities with unit tests"
```

---

## Task 7: RunCharts component

**Files:**
- Create: `control-plane/frontend/src/components/RunCharts.jsx`

- [ ] **Step 1: Create RunCharts.jsx**

Create `control-plane/frontend/src/components/RunCharts.jsx`:

```jsx
import {
  LineChart, Line, XAxis, YAxis, CartesianGrid,
  Tooltip, ResponsiveContainer,
} from 'recharts'
import { normalizeTimeseries, promToChartData } from '../lib/chartDataUtils.js'

const GRID   = '#2a3045'
const MUTED  = '#7a8399'
const TEXT   = '#e8edf8'
const SURFACE = '#171c28'
const BORDER  = '#2a3045'

const axisProps = {
  stroke: MUTED,
  tick: { fill: MUTED, fontSize: 10 },
}

const gridProps = {
  strokeDasharray: '3 3',
  stroke: GRID,
}

const tooltipStyle = {
  contentStyle: { background: SURFACE, border: `1px solid ${BORDER}`, color: TEXT, fontSize: 11 },
  labelFormatter: v => `t = ${v}s`,
}

const lineBase = { type: 'monotone', dot: false, isAnimationActive: false }

function fmtNum(v) {
  if (v == null) return ''
  if (v >= 1e6) return `${(v / 1e6).toFixed(1)}M`
  if (v >= 1e3) return `${(v / 1e3).toFixed(0)}K`
  return v.toFixed(1)
}

function ChartCard({ title, badge, unit, children }) {
  return (
    <div style={{ background: SURFACE, border: `1px solid ${BORDER}`, borderRadius: 5, padding: 12 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
        <span style={{ color: TEXT, fontSize: 12, fontWeight: 600 }}>{title}</span>
        <span className={`source-badge source-badge-${badge}`}>
          {badge === 'omb' ? 'OMB' : 'Redpanda'}
        </span>
        {unit && <span style={{ marginLeft: 'auto', color: MUTED, fontSize: 10 }}>{unit}</span>}
      </div>
      {children}
    </div>
  )
}

export default function RunCharts({ livePoints, metricsOut, promSamples, messageSize, isLive }) {
  // During a live run use livePoints. After completion, fall back to stored timeseries.
  const chartData = (isLive || (livePoints && livePoints.length > 0))
    ? (livePoints || [])
    : normalizeTimeseries(metricsOut, messageSize)

  const promData    = promToChartData(promSamples)
  const hasMBSec    = chartData.some(p => p.pubMBSec != null)
  const hasBacklog  = chartData.some(p => p.backlog  != null)
  const hasLatency  = chartData.some(p => p.pubP99   != null)
  const hasPrometheus = promData.length > 0

  if (!chartData.length && !hasPrometheus) return null

  return (
    <div style={{ marginBottom: 16 }}>

      {/* Row 1 — 3-up throughput + backlog */}
      {chartData.length > 0 && (
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 8, marginBottom: 8 }}>

          <ChartCard title="Throughput" badge="omb" unit="msg/s">
            <ResponsiveContainer width="100%" height={160}>
              <LineChart data={chartData} syncId="run">
                <CartesianGrid {...gridProps} />
                <XAxis dataKey="t" {...axisProps} tickFormatter={v => `${v}s`} />
                <YAxis {...axisProps} tickFormatter={fmtNum} width={48} />
                <Tooltip {...tooltipStyle} />
                <Line {...lineBase} dataKey="pubMsgSec"  stroke="#e63946" name="pub" />
                <Line {...lineBase} dataKey="consMsgSec" stroke="#4ade80" strokeDasharray="5 3" name="cons" />
              </LineChart>
            </ResponsiveContainer>
          </ChartCard>

          <ChartCard title="Throughput" badge="omb" unit="MB/s">
            <ResponsiveContainer width="100%" height={160}>
              <LineChart data={hasMBSec ? chartData : []} syncId="run">
                <CartesianGrid {...gridProps} />
                <XAxis dataKey="t" {...axisProps} tickFormatter={v => `${v}s`} />
                <YAxis {...axisProps} tickFormatter={v => v?.toFixed(1)} width={48} />
                <Tooltip {...tooltipStyle} />
                <Line {...lineBase} dataKey="pubMBSec"  stroke="#e63946" name="pub" />
                <Line {...lineBase} dataKey="consMBSec" stroke="#4ade80" strokeDasharray="5 3" name="cons" />
              </LineChart>
            </ResponsiveContainer>
            {!hasMBSec && (
              <div style={{ color: MUTED, fontSize: 11, textAlign: 'center', padding: '20px 0' }}>
                MB/s available during live run
              </div>
            )}
          </ChartCard>

          <ChartCard title="Backlog" badge="omb" unit="msgs">
            <ResponsiveContainer width="100%" height={160}>
              <LineChart data={hasBacklog ? chartData : []} syncId="run">
                <CartesianGrid {...gridProps} />
                <XAxis dataKey="t" {...axisProps} tickFormatter={v => `${v}s`} />
                <YAxis {...axisProps} tickFormatter={fmtNum} width={48} />
                <Tooltip {...tooltipStyle} />
                <Line {...lineBase} dataKey="backlog" stroke="#818cf8" name="backlog" />
              </LineChart>
            </ResponsiveContainer>
          </ChartCard>

        </div>
      )}

      {/* Row 2 — 2-up latency (live data only — per-sample P99 not in stored timeseries) */}
      {hasLatency && (
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8, marginBottom: 8 }}>

          <ChartCard title="Publish Latency" badge="omb" unit="ms">
            <ResponsiveContainer width="100%" height={160}>
              <LineChart data={chartData} syncId="run">
                <CartesianGrid {...gridProps} />
                <XAxis dataKey="t" {...axisProps} tickFormatter={v => `${v}s`} />
                <YAxis {...axisProps} tickFormatter={v => v?.toFixed(1)} width={48} />
                <Tooltip {...tooltipStyle} />
                <Line {...lineBase} dataKey="pubP99" stroke="#f59e0b" name="p99" />
              </LineChart>
            </ResponsiveContainer>
          </ChartCard>

          <ChartCard title="E2E Latency" badge="omb" unit="ms">
            <ResponsiveContainer width="100%" height={160}>
              <LineChart data={chartData} syncId="run">
                <CartesianGrid {...gridProps} />
                <XAxis dataKey="t" {...axisProps} tickFormatter={v => `${v}s`} />
                <YAxis {...axisProps} tickFormatter={v => v?.toFixed(1)} width={48} />
                <Tooltip {...tooltipStyle} />
                <Line {...lineBase} dataKey="e2eP99" stroke="#fb923c" name="p99" />
              </LineChart>
            </ResponsiveContainer>
          </ChartCard>

        </div>
      )}

      {/* Row 3 — Prometheus charts (only when data exists) */}
      {hasPrometheus && (
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>

          <ChartCard title="Broker bytes in / out" badge="redpanda" unit="MB/s">
            <ResponsiveContainer width="100%" height={160}>
              <LineChart data={promData} syncId="run">
                <CartesianGrid {...gridProps} />
                <XAxis dataKey="t" {...axisProps} tickFormatter={v => `${v}s`} />
                <YAxis {...axisProps} tickFormatter={v => v?.toFixed(2)} width={48} />
                <Tooltip {...tooltipStyle} />
                <Line {...lineBase} dataKey="bytesInMBSec"  stroke="#38bdf8" name="in" />
                <Line {...lineBase} dataKey="bytesOutMBSec" stroke="#7dd3fc" strokeDasharray="5 3" name="out" />
              </LineChart>
            </ResponsiveContainer>
          </ChartCard>

          <ChartCard title="Records produced / sec" badge="redpanda" unit="rec/s">
            <ResponsiveContainer width="100%" height={160}>
              <LineChart data={promData} syncId="run">
                <CartesianGrid {...gridProps} />
                <XAxis dataKey="t" {...axisProps} tickFormatter={v => `${v}s`} />
                <YAxis {...axisProps} tickFormatter={fmtNum} width={48} />
                <Tooltip {...tooltipStyle} />
                <Line {...lineBase} dataKey="recordsPerSec" stroke="#a78bfa" name="records/s" />
              </LineChart>
            </ResponsiveContainer>
          </ChartCard>

        </div>
      )}

    </div>
  )
}
```

- [ ] **Step 2: Commit**

```bash
git add control-plane/frontend/src/components/RunCharts.jsx
git commit -m "feat: RunCharts component with Recharts, OMB/Redpanda source badges"
```

---

## Task 8: Wire RunCharts into RunDetailPage

**Files:**
- Modify: `control-plane/frontend/src/pages/RunDetailPage.jsx`

- [ ] **Step 1: Add imports at the top of RunDetailPage.jsx**

After the existing imports, add:

```js
import RunCharts from '../components/RunCharts.jsx'
import { parseLiveMetric } from '../lib/ombLogParser.js'
import { parseWorkloadYaml } from '../components/WorkloadForm.jsx'
```

- [ ] **Step 2: Add livePoints state**

Inside `RunDetailPage()`, after the existing state declarations (`const [logs, setLogs] ...`), add:

```js
const [livePoints, setLivePoints] = useState([])
```

- [ ] **Step 3: Feed log lines into parseLiveMetric**

Inside the `ws.onmessage` handler, after `setLogs(prev => [...prev, evt.data])`, add:

```js
setLivePoints(prev => {
  const point = parseLiveMetric(evt.data, prev.length)
  if (!point) return prev
  return [...prev, point]
})
```

The full updated `ws.onmessage` block should look like:

```js
ws.onmessage = (evt) => {
  try {
    const msg = JSON.parse(evt.data)
    if (msg.type === 'done') {
      setLogDone(true)
      loadRun()
      return
    }
  } catch { /* not JSON — it's a log line */ }
  setLogs(prev => [...prev, evt.data])
  setLivePoints(prev => {
    const point = parseLiveMetric(evt.data, prev.length)
    if (!point) return prev
    return [...prev, point]
  })
}
```

- [ ] **Step 4: Extract messageSize from workload config**

After the `if (!run) return null` early return, the code currently reads:

```js
  const m = run.metrics
```

Add `messageSize` directly after that line:

```js
  const m = run.metrics
  const messageSize = run.workload_config
    ? (parseWorkloadYaml(run.workload_config).values.messageSize || 0)
    : 0
```

- [ ] **Step 5: Remove the old SVG LineChart component**

Delete lines 59–116 (the entire `function LineChart({ data, xKey, yKey, label, color })` block).

- [ ] **Step 6: Remove the old Prometheus chart render block**

Find and delete this block (currently just after the LatencyTable render):

```jsx
      {/* Prometheus throughput chart */}
      {promSamples.length > 0 && (
        <LineChart
          data={promSamples}
          xKey="t"
          yKey="bytes_in_per_sec"
          label="Bytes In/sec (Prometheus)"
        />
      )}
```

- [ ] **Step 7: Add RunCharts below the summary metrics, above the log**

Find the `{/* Log output */}` comment block. Directly above it, insert:

```jsx
      {/* Charts */}
      <RunCharts
        livePoints={livePoints}
        metricsOut={run.metrics}
        promSamples={promSamples}
        messageSize={messageSize}
        isLive={run.status === 'running'}
      />
```

- [ ] **Step 8: Add console warning when no live metrics after 10 seconds**

The WebSocket `useEffect` captures state in a closure, so `livePoints` would always be stale inside a timer. Use a ref instead. At the top of `RunDetailPage()`, alongside the existing `wsRef`, add:

```js
const liveMatchedRef = useRef(false)
```

In the `setLivePoints` updater (from Step 3), set the ref on first match:

```js
setLivePoints(prev => {
  const point = parseLiveMetric(evt.data, prev.length)
  if (!point) return prev
  liveMatchedRef.current = true
  return [...prev, point]
})
```

Then, inside the WebSocket `useEffect`, after `ws.onerror = ...`, replace the existing `return () => ws.close()` with:

```js
const warnTimer = setTimeout(() => {
  if (!liveMatchedRef.current) {
    console.warn('[RunCharts] No OMB stat lines matched after 10s. Check parseLiveMetric regex against actual log output.')
  }
}, 10_000)
return () => { ws.close(); clearTimeout(warnTimer) }
```

- [ ] **Step 9: Verify the build compiles**

```bash
cd control-plane/frontend && npm run build
```

Expected: Build completes with no errors.

- [ ] **Step 10: Commit**

```bash
git add control-plane/frontend/src/pages/RunDetailPage.jsx
git commit -m "feat: live Recharts charts on run detail page, WebSocket log parsing"
```

---

## Task 9: Integration verification

- [ ] **Step 1: Run all unit tests**

```bash
cd control-plane/frontend && npm test
```

Expected: All tests pass (ombLogParser + chartDataUtils).

- [ ] **Step 2: Start dev server**

```bash
cd control-plane/frontend && npm run dev
```

- [ ] **Step 3: Check completed run detail page**

Navigate to a completed run. Verify:
- Metric tiles render correctly in dark theme
- OMB throughput charts (msg/s, MB/s, backlog) render in the 3-up grid
- Prometheus charts appear in the 2-up grid if the run has Prometheus data
- Latency charts are hidden (expected — stored timeseries has no per-sample latency)
- All chart card headers show the correct OMB or Redpanda badge
- Hovering any chart syncs the cursor across all charts simultaneously

- [ ] **Step 4: Check the New Run page YAML preview**

Click "+ New Run". Confirm:
- Driver and Workload YAML preview textareas fill their full column width
- Dragging the bottom-right corner resizes in both horizontal and vertical directions

- [ ] **Step 5: Verify live chart behavior (if a cluster is available)**

Launch a new run. While it is running:
- The throughput charts should start populating within 1–2 seconds of the first stat line
- Open the browser console — if no data appears after 10 seconds, a warning will indicate the regex needs adjustment against the actual OMB log format

- [ ] **Step 6: Final build**

```bash
npm run build
```

Expected: No errors. Check `build/` output exists.

- [ ] **Step 7: Commit**

```bash
git add -A
git commit -m "chore: verified dark theme, YAML fix, and live charts integration"
```
