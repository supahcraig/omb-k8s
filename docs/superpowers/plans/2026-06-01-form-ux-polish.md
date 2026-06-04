# Form UX Polish Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add smart dropdown inputs for well-known Kafka properties in the driver form, add colored `LABEL ———————` section dividers to both forms, and convert WorkloadForm from structured labeled inputs to the same key/value row model as DriverForm.

**Architecture:** `driverFormUtils.js` gains a `KNOWN_PROP_OPTIONS` export; `PropertySection` in `DriverForm.jsx` dynamically renders a `<select>` when the row key matches a known property. A new `workloadFormUtils.js` provides parallel utilities for the workload form. `WorkloadForm.jsx` is rewritten to use four key/value sections (Topology, Load, Timing, Payload) plus an Additional overflow section. Both forms use a `SectionDivider` component (indigo for driver, green for workload) that renders the `LABEL ———` visual.

**Tech Stack:** React 18, Vitest

---

## File Map

**Modified:**
- `control-plane/frontend/src/lib/driverFormUtils.js` — add `KNOWN_PROP_OPTIONS`
- `control-plane/frontend/src/lib/__tests__/driverFormUtils.test.js` — add tests for `KNOWN_PROP_OPTIONS`
- `control-plane/frontend/src/components/DriverForm.jsx` — `PropertySection` uses smart inputs; replace `section-label` divs with `SectionDivider`

**Created:**
- `control-plane/frontend/src/lib/workloadFormUtils.js` — `parseWorkloadYamlToRows`, `buildWorkloadYaml`, backward-compat `parseWorkloadYaml`, defaults, known options/types/hints
- `control-plane/frontend/src/lib/__tests__/workloadFormUtils.test.js` — full test suite

**Modified:**
- `control-plane/frontend/src/components/WorkloadForm.jsx` — full rewrite to key/value row model; re-exports `parseWorkloadYaml` for RunDetailPage backward compatibility

---

## Task 1: Add KNOWN_PROP_OPTIONS to driverFormUtils.js

**Files:**
- Modify: `control-plane/frontend/src/lib/driverFormUtils.js`
- Modify: `control-plane/frontend/src/lib/__tests__/driverFormUtils.test.js`

- [ ] **Step 1: Add failing tests**

In `driverFormUtils.test.js`, add a new `describe` block at the bottom:

```js
import {
  parseDriverYaml,
  buildDriverYaml,
  buildCommonConfigFromCluster,
  deriveProtocol,
  KNOWN_PROP_OPTIONS,
} from '../driverFormUtils.js'

// ... existing tests ...

describe('KNOWN_PROP_OPTIONS', () => {
  it('defines compression.type with 5 options including none', () => {
    expect(KNOWN_PROP_OPTIONS['compression.type'].type).toBe('select')
    expect(KNOWN_PROP_OPTIONS['compression.type'].options).toContain('none')
    expect(KNOWN_PROP_OPTIONS['compression.type'].options).toHaveLength(5)
  })

  it('defines acks with exactly all/1/0', () => {
    expect(KNOWN_PROP_OPTIONS['acks'].options).toEqual(['all', '1', '0'])
  })

  it('defines auto.offset.reset with earliest and latest', () => {
    expect(KNOWN_PROP_OPTIONS['auto.offset.reset'].options).toEqual(['earliest', 'latest'])
  })

  it('defines enable.auto.commit with false and true', () => {
    expect(KNOWN_PROP_OPTIONS['enable.auto.commit'].options).toContain('false')
    expect(KNOWN_PROP_OPTIONS['enable.auto.commit'].options).toContain('true')
  })

  it('defines security.protocol with all four variants', () => {
    expect(KNOWN_PROP_OPTIONS['security.protocol'].options).toEqual(
      ['PLAINTEXT', 'SSL', 'SASL_PLAINTEXT', 'SASL_SSL']
    )
  })

  it('defines sasl.mechanism with SCRAM-SHA-256, SCRAM-SHA-512, PLAIN', () => {
    expect(KNOWN_PROP_OPTIONS['sasl.mechanism'].options).toEqual(
      ['SCRAM-SHA-256', 'SCRAM-SHA-512', 'PLAIN']
    )
  })

  it('all entries have type select', () => {
    for (const entry of Object.values(KNOWN_PROP_OPTIONS)) {
      expect(entry.type).toBe('select')
    }
  })
})
```

- [ ] **Step 2: Run tests to confirm they fail**

```bash
cd /Users/cnelson/sandbox/omb_k8s/aws_private/omb-k8s/control-plane/frontend
npm test -- driverFormUtils 2>&1 | tail -10
```

Expected: 7 new failures because `KNOWN_PROP_OPTIONS` is not exported yet.

- [ ] **Step 3: Add KNOWN_PROP_OPTIONS to driverFormUtils.js**

Append to the bottom of `control-plane/frontend/src/lib/driverFormUtils.js`:

```js
export const KNOWN_PROP_OPTIONS = {
  'compression.type':   { type: 'select', options: ['none', 'snappy', 'lz4', 'zstd', 'gzip'] },
  'acks':               { type: 'select', options: ['all', '1', '0'] },
  'auto.offset.reset':  { type: 'select', options: ['earliest', 'latest'] },
  'enable.auto.commit': { type: 'select', options: ['false', 'true'] },
  'security.protocol':  { type: 'select', options: ['PLAINTEXT', 'SSL', 'SASL_PLAINTEXT', 'SASL_SSL'] },
  'sasl.mechanism':     { type: 'select', options: ['SCRAM-SHA-256', 'SCRAM-SHA-512', 'PLAIN'] },
}
```

- [ ] **Step 4: Run all tests — all must pass**

```bash
npm test 2>&1 | tail -8
```

Expected: all tests pass including the 7 new ones.

- [ ] **Step 5: Commit**

```bash
cd /Users/cnelson/sandbox/omb_k8s/aws_private/omb-k8s
git add control-plane/frontend/src/lib/driverFormUtils.js \
        control-plane/frontend/src/lib/__tests__/driverFormUtils.test.js
git commit -m "feat: add KNOWN_PROP_OPTIONS for smart driver config inputs"
```

---

## Task 2: Update DriverForm — smart value inputs and SectionDivider

**Files:**
- Modify: `control-plane/frontend/src/components/DriverForm.jsx`

**Context:** `DriverForm.jsx` imports from `../lib/driverFormUtils.js`. It has a `PropertySection` component and four section calls. This task:
1. Adds `KNOWN_PROP_OPTIONS` to the import
2. Adds a `SectionDivider` component (indigo colored `LABEL ———` row)
3. Updates `PropertySection` to render a `<select>` when the row's key matches a known prop, free text otherwise
4. Replaces the existing `<div className="section-label">Per-Run Settings</div>` with `<SectionDivider>`

The Connection box (`connection-box` / `section-label` inside it) is untouched.

- [ ] **Step 1: Read the current DriverForm.jsx**

Read `/Users/cnelson/sandbox/omb_k8s/aws_private/omb-k8s/control-plane/frontend/src/components/DriverForm.jsx` in full before editing.

- [ ] **Step 2: Add KNOWN_PROP_OPTIONS to the import from driverFormUtils**

Find:
```js
import {
  DRIVER_OPTIONS,
  parseDriverYaml,
  buildDriverYaml,
  buildCommonConfigFromCluster,
  deriveProtocol,
} from '../lib/driverFormUtils.js'
```

Replace with:
```js
import {
  DRIVER_OPTIONS,
  KNOWN_PROP_OPTIONS,
  parseDriverYaml,
  buildDriverYaml,
  buildCommonConfigFromCluster,
  deriveProtocol,
} from '../lib/driverFormUtils.js'
```

- [ ] **Step 3: Add the SectionDivider component**

Add this immediately before the `PropertySection` function:

```jsx
const DRIVER_COLOR = '#818cf8'

function SectionDivider({ label }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8, margin: '16px 0 8px' }}>
      <span style={{
        fontSize: 10, fontWeight: 700, textTransform: 'uppercase',
        letterSpacing: '0.1em', color: DRIVER_COLOR, whiteSpace: 'nowrap',
      }}>
        {label}
      </span>
      <div style={{ flex: 1, height: 1, background: DRIVER_COLOR, opacity: 0.35 }} />
    </div>
  )
}
```

- [ ] **Step 4: Update PropertySection to use smart value inputs and SectionDivider**

Replace the entire `PropertySection` function with:

```jsx
function PropertySection({ title, rows, onChange }) {
  function addRow() {
    onChange([...rows, makeRow()])
  }
  function updateRow(i, field, val) {
    onChange(rows.map((r, idx) => idx === i ? { ...r, [field]: val } : r))
  }
  function removeRow(i) {
    onChange(rows.filter((_, idx) => idx !== i))
  }
  return (
    <div style={{ marginBottom: 16 }}>
      <SectionDivider label={title} />
      {rows.map((row, i) => {
        const knownProp = KNOWN_PROP_OPTIONS[row.key]
        return (
          <div key={row._id} style={{ display: 'grid', gridTemplateColumns: '1fr 1fr auto', gap: 8, marginBottom: 6 }}>
            <input
              className="form-input"
              placeholder="key"
              value={row.key}
              onChange={e => updateRow(i, 'key', e.target.value)}
            />
            {knownProp ? (
              <select
                className="form-select"
                value={row.value}
                onChange={e => updateRow(i, 'value', e.target.value)}
              >
                {knownProp.options.map(opt => (
                  <option key={opt} value={opt}>{opt}</option>
                ))}
              </select>
            ) : (
              <input
                className="form-input"
                placeholder="value"
                value={row.value}
                onChange={e => updateRow(i, 'value', e.target.value)}
              />
            )}
            <button type="button" className="btn btn-danger btn-sm" onClick={() => removeRow(i)}>×</button>
          </div>
        )
      })}
      <button type="button" className="btn btn-secondary btn-sm" onClick={addRow}>
        + Add property
      </button>
    </div>
  )
}
```

- [ ] **Step 5: Replace "Per-Run Settings" section-label div with SectionDivider**

Find:
```jsx
      {/* Scalar fields */}
      <div className="section-label">Per-Run Settings</div>
```

Replace with:
```jsx
      {/* Scalar fields */}
      <SectionDivider label="Per-Run Settings" />
```

- [ ] **Step 6: Build and run tests**

```bash
cd /Users/cnelson/sandbox/omb_k8s/aws_private/omb-k8s/control-plane/frontend
npm run build 2>&1 | tail -5
npm test 2>&1 | tail -8
```

Expected: build succeeds, all tests pass.

- [ ] **Step 7: Commit**

```bash
cd /Users/cnelson/sandbox/omb_k8s/aws_private/omb-k8s
git add control-plane/frontend/src/components/DriverForm.jsx
git commit -m "feat: smart dropdown inputs for known Kafka props, colored section dividers"
```

---

## Task 3: Create workloadFormUtils.js with tests

**Files:**
- Create: `control-plane/frontend/src/lib/workloadFormUtils.js`
- Create: `control-plane/frontend/src/lib/__tests__/workloadFormUtils.test.js`

**Context:** The workload YAML is a flat list of `key: value` lines (not block scalars). The new form organizes them into four sections (Topology, Load, Timing, Payload) plus an Additional overflow. `parseWorkloadYaml` must remain backward-compatible for `RunDetailPage.jsx` which calls it to extract `messageSize`, `warmupDurationMinutes`, `testDurationMinutes`, `producerRate`, `subscriptionsPerTopic`.

- [ ] **Step 1: Write failing tests**

Create `control-plane/frontend/src/lib/__tests__/workloadFormUtils.test.js`:

```js
import { describe, it, expect } from 'vitest'
import {
  parseWorkloadYamlToRows,
  buildWorkloadYaml,
  parseWorkloadYaml,
  WORKLOAD_KNOWN_PROP_OPTIONS,
  WORKLOAD_KNOWN_PROP_TYPES,
  WORKLOAD_PROP_HINTS,
  DEFAULT_TOPOLOGY_ROWS,
  DEFAULT_LOAD_ROWS,
  DEFAULT_TIMING_ROWS,
  DEFAULT_PAYLOAD_ROWS,
} from '../workloadFormUtils.js'

const SAMPLE_YAML = `topics: 2
partitionsPerTopic: 50
producersPerTopic: 2
consumerPerSubscription: 1
subscriptionsPerTopic: 1
messageSize: 512
producerRate: 50000
consumerBacklogSizeGB: 0
warmupDurationMinutes: 2
testDurationMinutes: 10
sampleRateMillis: 1000
useRandomizedPayloads: false
payloadFile: /payload/payload.data`

describe('parseWorkloadYamlToRows', () => {
  it('parses topology keys into topology section', () => {
    const { topology } = parseWorkloadYamlToRows(SAMPLE_YAML)
    expect(topology.find(r => r.key === 'topics')?.value).toBe('2')
    expect(topology.find(r => r.key === 'partitionsPerTopic')?.value).toBe('50')
  })

  it('parses load keys into load section', () => {
    const { load } = parseWorkloadYamlToRows(SAMPLE_YAML)
    expect(load.find(r => r.key === 'messageSize')?.value).toBe('512')
    expect(load.find(r => r.key === 'producerRate')?.value).toBe('50000')
  })

  it('parses timing keys into timing section', () => {
    const { timing } = parseWorkloadYamlToRows(SAMPLE_YAML)
    expect(timing.find(r => r.key === 'warmupDurationMinutes')?.value).toBe('2')
    expect(timing.find(r => r.key === 'testDurationMinutes')?.value).toBe('10')
  })

  it('parses payload keys into payload section', () => {
    const { payload } = parseWorkloadYamlToRows(SAMPLE_YAML)
    expect(payload.find(r => r.key === 'useRandomizedPayloads')?.value).toBe('false')
  })

  it('skips payloadFile', () => {
    const { topology, load, timing, payload, extra } = parseWorkloadYamlToRows(SAMPLE_YAML)
    const all = [...topology, ...load, ...timing, ...payload, ...extra]
    expect(all.find(r => r.key === 'payloadFile')).toBeUndefined()
  })

  it('puts unknown keys into extra', () => {
    const yaml = `topics: 1\ncustomKey: customValue`
    const { extra } = parseWorkloadYamlToRows(yaml)
    expect(extra).toEqual([{ key: 'customKey', value: 'customValue' }])
  })

  it('returns all empty arrays for null input', () => {
    const result = parseWorkloadYamlToRows(null)
    expect(result.topology).toEqual([])
    expect(result.load).toEqual([])
    expect(result.extra).toEqual([])
  })
})

describe('buildWorkloadYaml', () => {
  it('emits flat key: value lines', () => {
    const yaml = buildWorkloadYaml([
      { key: 'topics', value: '1' },
      { key: 'messageSize', value: '1024' },
    ])
    expect(yaml).toContain('topics: 1')
    expect(yaml).toContain('messageSize: 1024')
  })

  it('always appends payloadFile', () => {
    const yaml = buildWorkloadYaml([{ key: 'topics', value: '1' }])
    expect(yaml).toContain('payloadFile: /payload/payload.data')
  })

  it('skips rows with empty keys', () => {
    const yaml = buildWorkloadYaml([{ key: '', value: 'ignored' }, { key: 'topics', value: '1' }])
    expect(yaml).not.toContain(': ignored')
    expect(yaml).toContain('topics: 1')
  })

  it('does not duplicate payloadFile if already present', () => {
    const yaml = buildWorkloadYaml([
      { key: 'topics', value: '1' },
      { key: 'payloadFile', value: '/payload/payload.data' },
    ])
    const count = (yaml.match(/payloadFile/g) || []).length
    expect(count).toBe(1)
  })
})

describe('parseWorkloadYaml (backward compat)', () => {
  it('returns numeric values for number fields', () => {
    const { values } = parseWorkloadYaml(SAMPLE_YAML)
    expect(values.topics).toBe(2)
    expect(values.messageSize).toBe(512)
    expect(values.producerRate).toBe(50000)
  })

  it('returns boolean for useRandomizedPayloads', () => {
    const { values } = parseWorkloadYaml(SAMPLE_YAML)
    expect(values.useRandomizedPayloads).toBe(false)
  })

  it('puts unknown keys in customFields', () => {
    const yaml = `topics: 1\ncustomKey: hello`
    const { customFields } = parseWorkloadYaml(yaml)
    expect(customFields).toContainEqual({ key: 'customKey', value: 'hello' })
  })

  it('returns DEFAULTS for missing keys', () => {
    const { values } = parseWorkloadYaml('')
    expect(values.topics).toBe(1)
    expect(values.partitionsPerTopic).toBe(100)
  })
})

describe('defaults', () => {
  it('DEFAULT_TOPOLOGY_ROWS has topics, partitions, producers, consumer, subscriptions', () => {
    const keys = DEFAULT_TOPOLOGY_ROWS.map(r => r.key)
    expect(keys).toContain('topics')
    expect(keys).toContain('partitionsPerTopic')
    expect(keys).toContain('producersPerTopic')
    expect(keys).toContain('consumerPerSubscription')
    expect(keys).toContain('subscriptionsPerTopic')
  })

  it('DEFAULT_LOAD_ROWS has messageSize, producerRate, consumerBacklogSizeGB', () => {
    const keys = DEFAULT_LOAD_ROWS.map(r => r.key)
    expect(keys).toContain('messageSize')
    expect(keys).toContain('producerRate')
    expect(keys).toContain('consumerBacklogSizeGB')
  })

  it('DEFAULT_TIMING_ROWS has warmup, test, sampleRate', () => {
    const keys = DEFAULT_TIMING_ROWS.map(r => r.key)
    expect(keys).toContain('warmupDurationMinutes')
    expect(keys).toContain('testDurationMinutes')
    expect(keys).toContain('sampleRateMillis')
  })

  it('DEFAULT_PAYLOAD_ROWS has useRandomizedPayloads', () => {
    expect(DEFAULT_PAYLOAD_ROWS[0].key).toBe('useRandomizedPayloads')
    expect(DEFAULT_PAYLOAD_ROWS[0].value).toBe('false')
  })
})

describe('WORKLOAD_KNOWN_PROP_OPTIONS', () => {
  it('defines useRandomizedPayloads as select with false/true', () => {
    expect(WORKLOAD_KNOWN_PROP_OPTIONS['useRandomizedPayloads'].type).toBe('select')
    expect(WORKLOAD_KNOWN_PROP_OPTIONS['useRandomizedPayloads'].options).toEqual(['false', 'true'])
  })
})

describe('WORKLOAD_KNOWN_PROP_TYPES', () => {
  it('marks numeric workload fields as number', () => {
    expect(WORKLOAD_KNOWN_PROP_TYPES['topics']).toBe('number')
    expect(WORKLOAD_KNOWN_PROP_TYPES['messageSize']).toBe('number')
    expect(WORKLOAD_KNOWN_PROP_TYPES['producerRate']).toBe('number')
  })
})

describe('WORKLOAD_PROP_HINTS', () => {
  it('has hints for messageSize, producerRate, timing fields', () => {
    expect(WORKLOAD_PROP_HINTS['messageSize']).toBe('bytes')
    expect(WORKLOAD_PROP_HINTS['producerRate']).toBe('msg/s')
    expect(WORKLOAD_PROP_HINTS['warmupDurationMinutes']).toBe('min')
    expect(WORKLOAD_PROP_HINTS['testDurationMinutes']).toBe('min')
    expect(WORKLOAD_PROP_HINTS['sampleRateMillis']).toBe('ms')
  })
})
```

- [ ] **Step 2: Run tests to confirm they fail**

```bash
cd /Users/cnelson/sandbox/omb_k8s/aws_private/omb-k8s/control-plane/frontend
npm test -- workloadFormUtils 2>&1 | tail -10
```

Expected: import failures.

- [ ] **Step 3: Create workloadFormUtils.js**

Create `control-plane/frontend/src/lib/workloadFormUtils.js`:

```js
// ── Defaults ─────────────────────────────────────────────────────────────────

export const DEFAULT_TOPOLOGY_ROWS = [
  { key: 'topics',                  value: '1'    },
  { key: 'partitionsPerTopic',      value: '100'  },
  { key: 'producersPerTopic',       value: '4'    },
  { key: 'consumerPerSubscription', value: '1'    },
  { key: 'subscriptionsPerTopic',   value: '1'    },
]

export const DEFAULT_LOAD_ROWS = [
  { key: 'messageSize',           value: '1024'   },
  { key: 'producerRate',          value: '100000' },
  { key: 'consumerBacklogSizeGB', value: '0'      },
]

export const DEFAULT_TIMING_ROWS = [
  { key: 'warmupDurationMinutes', value: '1'    },
  { key: 'testDurationMinutes',   value: '5'    },
  { key: 'sampleRateMillis',      value: '1000' },
]

export const DEFAULT_PAYLOAD_ROWS = [
  { key: 'useRandomizedPayloads', value: 'false' },
]

// ── Smart input metadata ─────────────────────────────────────────────────────

export const WORKLOAD_KNOWN_PROP_OPTIONS = {
  'useRandomizedPayloads': { type: 'select', options: ['false', 'true'] },
}

export const WORKLOAD_KNOWN_PROP_TYPES = {
  'topics':                 'number',
  'partitionsPerTopic':     'number',
  'messageSize':            'number',
  'subscriptionsPerTopic':  'number',
  'producersPerTopic':      'number',
  'consumerPerSubscription':'number',
  'producerRate':           'number',
  'consumerBacklogSizeGB':  'number',
  'testDurationMinutes':    'number',
  'warmupDurationMinutes':  'number',
  'sampleRateMillis':       'number',
  'randomizedPayloadPoolSize': 'number',
}

export const WORKLOAD_PROP_HINTS = {
  'messageSize':            'bytes',
  'producerRate':           'msg/s',
  'consumerBacklogSizeGB':  'GB',
  'warmupDurationMinutes':  'min',
  'testDurationMinutes':    'min',
  'sampleRateMillis':       'ms',
}

// ── Section membership ───────────────────────────────────────────────────────

const TOPOLOGY_KEYS  = new Set(['topics','partitionsPerTopic','producersPerTopic','consumerPerSubscription','subscriptionsPerTopic'])
const LOAD_KEYS      = new Set(['messageSize','producerRate','consumerBacklogSizeGB'])
const TIMING_KEYS    = new Set(['warmupDurationMinutes','testDurationMinutes','sampleRateMillis'])
const PAYLOAD_KEYS   = new Set(['useRandomizedPayloads','randomizedPayloadPoolSize'])

// ── Row parser ───────────────────────────────────────────────────────────────

export function parseWorkloadYamlToRows(yamlStr) {
  const empty = { topology: [], load: [], timing: [], payload: [], extra: [] }
  if (!yamlStr) return empty

  const topology = [], load = [], timing = [], payload = [], extra = []

  for (const line of yamlStr.split('\n')) {
    const match = line.match(/^(\w+):\s*(.+)$/)
    if (!match) continue
    const [, key, rawVal] = match
    if (key === 'payloadFile') continue
    const row = { key, value: rawVal.trim() }
    if      (TOPOLOGY_KEYS.has(key))  topology.push(row)
    else if (LOAD_KEYS.has(key))      load.push(row)
    else if (TIMING_KEYS.has(key))    timing.push(row)
    else if (PAYLOAD_KEYS.has(key))   payload.push(row)
    else                              extra.push(row)
  }

  return { topology, load, timing, payload, extra }
}

// ── YAML builder ─────────────────────────────────────────────────────────────

export function buildWorkloadYaml(allRows) {
  const lines = allRows
    .filter(r => r.key.trim() && r.key !== 'payloadFile')
    .map(r => `${r.key}: ${r.value}`)
  lines.push('payloadFile: /payload/payload.data')
  return lines.join('\n')
}

// ── Backward-compatible parser (used by RunDetailPage) ────────────────────────

const VALUE_DEFAULTS = {
  topics: 1, partitionsPerTopic: 100, messageSize: 1024, subscriptionsPerTopic: 1,
  producersPerTopic: 4, consumerPerSubscription: 1, producerRate: 100000,
  consumerBacklogSizeGB: 0, testDurationMinutes: 5, warmupDurationMinutes: 1,
  sampleRateMillis: 1000, useRandomizedPayloads: false, randomizedPayloadPoolSize: '',
}

export function parseWorkloadYaml(yamlStr) {
  const values = { ...VALUE_DEFAULTS }
  const customFields = []
  if (!yamlStr) return { values, customFields }

  for (const line of yamlStr.split('\n')) {
    const match = line.match(/^(\w+):\s*(.+)$/)
    if (!match) continue
    const [, key, rawVal] = match
    const val = rawVal.trim()
    if (key === 'payloadFile') continue
    let parsed
    if (val === 'true')  parsed = true
    else if (val === 'false') parsed = false
    else { const num = Number(val); parsed = !isNaN(num) && val !== '' ? num : val }
    if (key in VALUE_DEFAULTS) values[key] = parsed
    else customFields.push({ key, value: val })
  }
  return { values, customFields }
}
```

- [ ] **Step 4: Run all tests — all must pass**

```bash
cd /Users/cnelson/sandbox/omb_k8s/aws_private/omb-k8s/control-plane/frontend
npm test 2>&1 | tail -8
```

Expected: all tests pass.

- [ ] **Step 5: Commit**

```bash
cd /Users/cnelson/sandbox/omb_k8s/aws_private/omb-k8s
git add control-plane/frontend/src/lib/workloadFormUtils.js \
        control-plane/frontend/src/lib/__tests__/workloadFormUtils.test.js
git commit -m "feat: add workloadFormUtils with parser, builder, and tests"
```

---

## Task 4: Rewrite WorkloadForm.jsx with key/value rows

**Files:**
- Modify: `control-plane/frontend/src/components/WorkloadForm.jsx`

**Context:**
- `WorkloadForm.jsx` currently exports `parseWorkloadYaml` and `buildWorkloadYaml` — `RunDetailPage.jsx` imports `parseWorkloadYaml` from this file. The new file re-exports `parseWorkloadYaml` from `workloadFormUtils.js` to preserve the import path.
- The new `buildWorkloadYaml` in `workloadFormUtils.js` takes `allRows` (not `values, customFields`). The old export is dropped.
- The workload form uses green (`#4ade80`) for its `SectionDivider`.
- A module-level `_nextId` counter and `makeRow` provide stable React keys (same pattern as DriverForm).
- Five sections: Topology, Load, Timing, Payload, Additional. Additional is always rendered even when empty so there is always a visible place to add unknown fields.

- [ ] **Step 1: Read the current WorkloadForm.jsx**

Read `/Users/cnelson/sandbox/omb_k8s/aws_private/omb-k8s/control-plane/frontend/src/components/WorkloadForm.jsx` in full.

- [ ] **Step 2: Replace WorkloadForm.jsx entirely**

Write the complete new file:

```jsx
import { useEffect, useRef, useState } from 'react'
import {
  WORKLOAD_KNOWN_PROP_OPTIONS,
  WORKLOAD_KNOWN_PROP_TYPES,
  WORKLOAD_PROP_HINTS,
  DEFAULT_TOPOLOGY_ROWS,
  DEFAULT_LOAD_ROWS,
  DEFAULT_TIMING_ROWS,
  DEFAULT_PAYLOAD_ROWS,
  parseWorkloadYamlToRows,
  buildWorkloadYaml,
} from '../lib/workloadFormUtils.js'

export { parseWorkloadYaml } from '../lib/workloadFormUtils.js'

let _nextId = 0
function makeRow(key = '', value = '') { return { _id: ++_nextId, key, value } }

const WORKLOAD_COLOR = '#4ade80'

function SectionDivider({ label }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8, margin: '16px 0 8px' }}>
      <span style={{
        fontSize: 10, fontWeight: 700, textTransform: 'uppercase',
        letterSpacing: '0.1em', color: WORKLOAD_COLOR, whiteSpace: 'nowrap',
      }}>
        {label}
      </span>
      <div style={{ flex: 1, height: 1, background: WORKLOAD_COLOR, opacity: 0.35 }} />
    </div>
  )
}

function PropValueInput({ rowKey, value, onChange }) {
  const knownOption = WORKLOAD_KNOWN_PROP_OPTIONS[rowKey]
  const knownType   = WORKLOAD_KNOWN_PROP_TYPES[rowKey]
  const hint        = WORKLOAD_PROP_HINTS[rowKey]

  if (knownOption?.type === 'select') {
    return (
      <select
        className="form-select"
        value={value}
        onChange={e => onChange(e.target.value)}
      >
        {knownOption.options.map(opt => (
          <option key={opt} value={opt}>{opt}</option>
        ))}
      </select>
    )
  }

  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
      <input
        type={knownType === 'number' ? 'number' : 'text'}
        className="form-input"
        placeholder="value"
        value={value}
        onChange={e => onChange(e.target.value)}
      />
      {hint && (
        <span style={{ fontSize: 11, color: 'var(--color-text-muted)', whiteSpace: 'nowrap' }}>
          {hint}
        </span>
      )}
    </div>
  )
}

function WorkloadSection({ title, rows, onChange }) {
  function addRow() {
    onChange([...rows, makeRow()])
  }
  function updateRow(i, field, val) {
    onChange(rows.map((r, idx) => idx === i ? { ...r, [field]: val } : r))
  }
  function removeRow(i) {
    onChange(rows.filter((_, idx) => idx !== i))
  }
  return (
    <div style={{ marginBottom: 16 }}>
      <SectionDivider label={title} />
      {rows.map((row, i) => (
        <div key={row._id} style={{ display: 'grid', gridTemplateColumns: '1fr 1fr auto', gap: 8, marginBottom: 6 }}>
          <input
            className="form-input"
            placeholder="key"
            value={row.key}
            onChange={e => updateRow(i, 'key', e.target.value)}
          />
          <PropValueInput
            rowKey={row.key}
            value={row.value}
            onChange={val => updateRow(i, 'value', val)}
          />
          <button type="button" className="btn btn-danger btn-sm" onClick={() => removeRow(i)}>×</button>
        </div>
      ))}
      <button type="button" className="btn btn-secondary btn-sm" onClick={addRow}>
        + Add property
      </button>
    </div>
  )
}

export default function WorkloadForm({ initialYaml, onChange }) {
  const hasYaml = !!initialYaml
  const { topology: pt, load: pl, timing: pti, payload: ppa, extra: pex } = parseWorkloadYamlToRows(initialYaml)
  const wrap = rows => rows.map(r => makeRow(r.key, r.value))

  const [topology, setTopology] = useState(pt.length  > 0 ? wrap(pt)  : hasYaml ? [] : DEFAULT_TOPOLOGY_ROWS.map(r => makeRow(r.key, r.value)))
  const [load,     setLoad]     = useState(pl.length  > 0 ? wrap(pl)  : hasYaml ? [] : DEFAULT_LOAD_ROWS.map(r => makeRow(r.key, r.value)))
  const [timing,   setTiming]   = useState(pti.length > 0 ? wrap(pti) : hasYaml ? [] : DEFAULT_TIMING_ROWS.map(r => makeRow(r.key, r.value)))
  const [payload,  setPayload]  = useState(ppa.length > 0 ? wrap(ppa) : hasYaml ? [] : DEFAULT_PAYLOAD_ROWS.map(r => makeRow(r.key, r.value)))
  const [extra,    setExtra]    = useState(wrap(pex))

  useEffect(() => {
    const allRows = [...topology, ...load, ...timing, ...payload, ...extra]
    onChange?.(buildWorkloadYaml(allRows))
  }, [topology, load, timing, payload, extra])

  return (
    <div>
      <WorkloadSection title="Topology" rows={topology} onChange={setTopology} />
      <WorkloadSection title="Load"     rows={load}     onChange={setLoad} />
      <WorkloadSection title="Timing"   rows={timing}   onChange={setTiming} />
      <WorkloadSection title="Payload"  rows={payload}  onChange={setPayload} />
      <WorkloadSection title="Additional" rows={extra}  onChange={setExtra} />
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

- [ ] **Step 4: Run all tests**

```bash
npm test 2>&1 | tail -8
```

Expected: all tests pass.

- [ ] **Step 5: Commit**

```bash
cd /Users/cnelson/sandbox/omb_k8s/aws_private/omb-k8s
git add control-plane/frontend/src/components/WorkloadForm.jsx
git commit -m "feat: rewrite WorkloadForm as key/value sections with colored dividers"
```

---

## Self-Review

**Spec coverage:**

| Requirement | Task |
|-------------|------|
| compression.type dropdown (none/snappy/lz4/zstd/gzip) | Task 1 KNOWN_PROP_OPTIONS + Task 2 PropertySection |
| acks dropdown (all/1/0) | Task 1 + Task 2 |
| auto.offset.reset dropdown (earliest/latest) | Task 1 + Task 2 |
| enable.auto.commit dropdown (false/true) | Task 1 + Task 2 |
| security.protocol dropdown (4 values) | Task 1 + Task 2 |
| sasl.mechanism dropdown (3 values) | Task 1 + Task 2 |
| Smart input only shows when key matches — free text otherwise | Task 2 `knownProp ? <select> : <input>` |
| Colored section divider `LABEL ———` | Tasks 2+4 `SectionDivider` component |
| Driver sections blue (#818cf8) | Task 2 `DRIVER_COLOR` |
| Workload sections green (#4ade80) | Task 4 `WORKLOAD_COLOR` |
| WorkloadForm single-column key/value rows | Task 4 |
| WorkloadForm sections: Topology, Load, Timing, Payload, Additional | Task 4 |
| Number inputs for numeric workload keys | Task 4 `PropValueInput` uses `type="number"` |
| Unit hints (bytes, msg/s, min, ms) | Task 3 `WORKLOAD_PROP_HINTS` + Task 4 `PropValueInput` |
| `parseWorkloadYaml` backward compat for RunDetailPage | Task 3 + Task 4 `export { parseWorkloadYaml }` |
| Default values preserved | Task 3 `DEFAULT_*_ROWS` match existing form defaults |
| Stable React keys | Task 4 `makeRow` + `row._id` |

**Placeholder scan:** None found — all steps contain complete code.

**Type consistency:**
- `DEFAULT_*_ROWS` are `{key: string, value: string}[]` — wrapped with `makeRow` in Task 4, producing `{_id, key, value}`
- `parseWorkloadYamlToRows` returns `{topology, load, timing, payload, extra}` each as `{key, value}[]` — consumed with `wrap()` in Task 4
- `buildWorkloadYaml(allRows)` takes `{key, value, _id}[]` — filters by `r.key.trim()`, uses only `key` and `value`, `_id` is ignored ✓
- `WORKLOAD_KNOWN_PROP_OPTIONS['useRandomizedPayloads']` used in `PropValueInput` as `knownOption?.type === 'select'` ✓
- `WORKLOAD_KNOWN_PROP_TYPES` values are `'number'` strings — consumed as `knownType === 'number'` ✓
- `WORKLOAD_PROP_HINTS` values are display strings — rendered inline after the input ✓
