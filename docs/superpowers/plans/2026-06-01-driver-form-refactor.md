# Driver Form Refactor — Sectioned Key/Value Properties

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Refactor `DriverForm` from fixed named inputs to four clearly-labeled sections (`topicConfig`, `producerConfig`, `consumerConfig`, `commonConfig`), each rendered as editable key=value rows with add/delete controls, while preserving all default values exactly.

**Architecture:** Pure parsing and building utilities are extracted to `lib/driverFormUtils.js` for testability. `DriverForm.jsx` is rewritten to manage four `{key, value}[]` state arrays (one per section) plus a scalar `values` object for `driver`, `replicationFactor`, and `reset`. A reusable `PropertySection` component renders each section's row list. On every state change, `buildDriverYaml` serializes all four sections to OMB block-scalar format.

**Tech Stack:** React 18, Vitest (existing test runner)

---

## File Map

**Created:**
- `control-plane/frontend/src/lib/driverFormUtils.js` — `parseDriverYaml`, `buildDriverYaml`, `buildCommonConfigFromCluster`, `deriveProtocol`, `DRIVER_OPTIONS`
- `control-plane/frontend/src/lib/__tests__/driverFormUtils.test.js` — unit tests for all utilities

**Modified:**
- `control-plane/frontend/src/components/DriverForm.jsx` — full rewrite; imports from `driverFormUtils.js`; re-exports `buildDriverYaml` for backward compatibility

---

## Task 1: Extract and test driver form utilities

**Files:**
- Create: `control-plane/frontend/src/lib/driverFormUtils.js`
- Create: `control-plane/frontend/src/lib/__tests__/driverFormUtils.test.js`

**Context:** `DriverForm.jsx` currently contains `parseDriverYaml`, `buildDriverYaml`, `deriveProtocol`, and `DRIVER_OPTIONS` as module-level code. Moving these to a pure JS file makes them independently testable without importing React or context.

The new `buildDriverYaml` signature changes from `(values, customFields, cluster)` to `(values, sections)` where `sections = { topicConfig, producerConfig, consumerConfig, commonConfig }` and each is `{key: string, value: string}[]`.

- [ ] **Step 1: Write the failing tests**

Create `control-plane/frontend/src/lib/__tests__/driverFormUtils.test.js`:

```js
import { describe, it, expect } from 'vitest'
import {
  parseDriverYaml,
  buildDriverYaml,
  buildCommonConfigFromCluster,
  deriveProtocol,
} from '../driverFormUtils.js'

const SAMPLE_YAML = `name: Redpanda
driverClass: io.openmessaging.benchmark.driver.redpanda.RedpandaBenchmarkDriver

replicationFactor: 3
reset: true

commonConfig: |
  bootstrap.servers=broker:9092
  security.protocol=SASL_SSL

topicConfig: |
  retention.ms=3600000

producerConfig: |
  acks=all
  linger.ms=1
  batch.size=131072

consumerConfig: |
  auto.offset.reset=earliest
  enable.auto.commit=false`

describe('parseDriverYaml', () => {
  it('parses driver name to driver value', () => {
    expect(parseDriverYaml(SAMPLE_YAML).values.driver).toBe('redpanda')
  })

  it('parses replicationFactor as number', () => {
    expect(parseDriverYaml(SAMPLE_YAML).values.replicationFactor).toBe(3)
  })

  it('parses reset as boolean', () => {
    expect(parseDriverYaml(SAMPLE_YAML).values.reset).toBe(true)
  })

  it('parses reset: false correctly', () => {
    expect(parseDriverYaml('replicationFactor: 1\nreset: false').values.reset).toBe(false)
  })

  it('parses topicConfig block into key/value rows', () => {
    expect(parseDriverYaml(SAMPLE_YAML).topicConfig).toEqual([
      { key: 'retention.ms', value: '3600000' },
    ])
  })

  it('parses producerConfig block into key/value rows', () => {
    expect(parseDriverYaml(SAMPLE_YAML).producerConfig).toEqual([
      { key: 'acks',      value: 'all'    },
      { key: 'linger.ms', value: '1'      },
      { key: 'batch.size',value: '131072' },
    ])
  })

  it('parses consumerConfig block into key/value rows', () => {
    expect(parseDriverYaml(SAMPLE_YAML).consumerConfig).toEqual([
      { key: 'auto.offset.reset',  value: 'earliest' },
      { key: 'enable.auto.commit', value: 'false'    },
    ])
  })

  it('parses commonConfig block into key/value rows', () => {
    expect(parseDriverYaml(SAMPLE_YAML).commonConfig).toEqual([
      { key: 'bootstrap.servers', value: 'broker:9092' },
      { key: 'security.protocol', value: 'SASL_SSL'    },
    ])
  })

  it('returns empty arrays for missing sections', () => {
    const r = parseDriverYaml('name: Redpanda\ndriverClass: x\nreplicationFactor: 1\nreset: true')
    expect(r.topicConfig).toEqual([])
    expect(r.producerConfig).toEqual([])
    expect(r.consumerConfig).toEqual([])
    expect(r.commonConfig).toEqual([])
  })

  it('returns empty result for null input', () => {
    const r = parseDriverYaml(null)
    expect(r.values).toEqual({})
    expect(r.topicConfig).toEqual([])
  })
})

describe('buildDriverYaml', () => {
  const base = { driver: 'redpanda', replicationFactor: 3, reset: true }
  const full = {
    topicConfig:    [{ key: 'retention.ms', value: '3600000' }],
    producerConfig: [{ key: 'acks', value: 'all' }, { key: 'linger.ms', value: '1' }],
    consumerConfig: [{ key: 'auto.offset.reset', value: 'earliest' }],
    commonConfig:   [{ key: 'bootstrap.servers', value: 'broker:9092' }],
  }

  it('serializes non-empty section as block scalar', () => {
    const yaml = buildDriverYaml(base, full)
    expect(yaml).toContain('topicConfig: |')
    expect(yaml).toContain('  retention.ms=3600000')
    expect(yaml).toContain('producerConfig: |')
    expect(yaml).toContain('  acks=all')
  })

  it('serializes empty section as empty string sentinel', () => {
    const yaml = buildDriverYaml(base, { topicConfig: [], producerConfig: [], consumerConfig: [], commonConfig: [] })
    expect(yaml).toContain('topicConfig: ""')
    expect(yaml).toContain('producerConfig: ""')
    expect(yaml).toContain('consumerConfig: ""')
    expect(yaml).toContain('commonConfig: ""')
  })

  it('skips rows with empty keys', () => {
    const yaml = buildDriverYaml(base, {
      ...full,
      topicConfig: [{ key: '', value: 'ignored' }, { key: 'retention.ms', value: '3600000' }],
    })
    expect(yaml).not.toContain('  =ignored')
    expect(yaml).toContain('  retention.ms=3600000')
  })

  it('includes reset: false correctly', () => {
    const yaml = buildDriverYaml({ ...base, reset: false }, { topicConfig: [], producerConfig: [], consumerConfig: [], commonConfig: [] })
    expect(yaml).toContain('reset: false')
  })

  it('round-trips through parseDriverYaml', () => {
    const yaml = buildDriverYaml(base, full)
    const parsed = parseDriverYaml(yaml)
    expect(parsed.topicConfig).toEqual(full.topicConfig)
    expect(parsed.producerConfig).toEqual(full.producerConfig)
    expect(parsed.consumerConfig).toEqual(full.consumerConfig)
    expect(parsed.commonConfig).toEqual(full.commonConfig)
    expect(parsed.values.replicationFactor).toBe(3)
    expect(parsed.values.reset).toBe(true)
  })
})

describe('buildCommonConfigFromCluster', () => {
  it('returns empty array for null cluster', () => {
    expect(buildCommonConfigFromCluster(null)).toEqual([])
  })

  it('returns empty array when no bootstrap_servers', () => {
    expect(buildCommonConfigFromCluster({ bootstrap_servers: '' })).toEqual([])
  })

  it('returns bootstrap.servers and PLAINTEXT protocol', () => {
    const rows = buildCommonConfigFromCluster({ bootstrap_servers: 'b:9092', tls_enabled: false, sasl_enabled: false })
    expect(rows[0]).toEqual({ key: 'bootstrap.servers', value: 'b:9092' })
    expect(rows[1]).toEqual({ key: 'security.protocol', value: 'PLAINTEXT' })
  })

  it('includes SASL rows when sasl_enabled', () => {
    const rows = buildCommonConfigFromCluster({
      bootstrap_servers: 'b:9092',
      tls_enabled: true,
      sasl_enabled: true,
      sasl_mechanism: 'SCRAM-SHA-256',
      sasl_username: 'user1',
      sasl_password: 'pass1',
    })
    expect(rows.find(r => r.key === 'sasl.mechanism')?.value).toBe('SCRAM-SHA-256')
    expect(rows.find(r => r.key === 'sasl.jaas.config')?.value).toContain('username="user1"')
    expect(rows.find(r => r.key === 'sasl.jaas.config')?.value).toContain('password="pass1"')
  })

  it('handles PLAIN mechanism login module', () => {
    const rows = buildCommonConfigFromCluster({
      bootstrap_servers: 'b:9092',
      tls_enabled: false,
      sasl_enabled: true,
      sasl_mechanism: 'PLAIN',
      sasl_username: 'u',
      sasl_password: 'p',
    })
    expect(rows.find(r => r.key === 'sasl.jaas.config')?.value).toContain('PlainLoginModule')
  })
})

describe('deriveProtocol', () => {
  it('returns SASL_SSL for tls+sasl', () => {
    expect(deriveProtocol({ tls_enabled: true, sasl_enabled: true })).toBe('SASL_SSL')
  })
  it('returns SSL for tls only', () => {
    expect(deriveProtocol({ tls_enabled: true, sasl_enabled: false })).toBe('SSL')
  })
  it('returns SASL_PLAINTEXT for sasl only', () => {
    expect(deriveProtocol({ tls_enabled: false, sasl_enabled: true })).toBe('SASL_PLAINTEXT')
  })
  it('returns PLAINTEXT for neither', () => {
    expect(deriveProtocol({ tls_enabled: false, sasl_enabled: false })).toBe('PLAINTEXT')
  })
  it('returns empty string for null', () => {
    expect(deriveProtocol(null)).toBe('')
  })
})
```

- [ ] **Step 2: Run tests to confirm they fail**

```bash
cd /Users/cnelson/sandbox/omb_k8s/aws_private/omb-k8s/control-plane/frontend
npm test -- driverFormUtils 2>&1 | tail -10
```

Expected: failures because `driverFormUtils.js` doesn't exist.

- [ ] **Step 3: Create driverFormUtils.js**

Create `control-plane/frontend/src/lib/driverFormUtils.js`:

```js
export const DRIVER_OPTIONS = [
  { label: 'Redpanda', value: 'redpanda', driverClass: 'io.openmessaging.benchmark.driver.redpanda.RedpandaBenchmarkDriver' },
  { label: 'Kafka',    value: 'kafka',    driverClass: 'io.openmessaging.benchmark.driver.kafka.KafkaBenchmarkDriver' },
]

const SECTION_KEYS = new Set(['topicConfig', 'producerConfig', 'consumerConfig', 'commonConfig'])

function parsePropLine(line) {
  const idx = line.indexOf('=')
  if (idx === -1) return { key: line.trim(), value: '' }
  return { key: line.slice(0, idx), value: line.slice(idx + 1) }
}

export function parseDriverYaml(yamlStr) {
  const result = { values: {}, topicConfig: [], producerConfig: [], consumerConfig: [], commonConfig: [] }
  if (!yamlStr) return result

  let currentSection = null

  for (const line of yamlStr.split('\n')) {
    const topMatch = line.match(/^([\w.]+):\s*(.*)$/)
    if (topMatch) {
      currentSection = null
      const [, key, rest] = topMatch
      const val = rest.trim()
      if (key === 'name') {
        const opt = DRIVER_OPTIONS.find(d => d.label === val)
        if (opt) result.values.driver = opt.value
      } else if (key === 'replicationFactor') {
        result.values.replicationFactor = Number(val)
      } else if (key === 'reset') {
        result.values.reset = val !== 'false'
      } else if (SECTION_KEYS.has(key) && val === '|') {
        currentSection = key
      }
      continue
    }
    const indented = line.match(/^  (.+)$/)
    if (indented && currentSection) {
      result[currentSection].push(parsePropLine(indented[1]))
    } else {
      currentSection = null
    }
  }

  return result
}

function buildSection(name, rows) {
  const filtered = rows.filter(r => r.key.trim())
  if (filtered.length === 0) return [`${name}: ""`]
  return [`${name}: |`, ...filtered.map(r => `  ${r.key}=${r.value}`)]
}

export function buildDriverYaml(values, { topicConfig, producerConfig, consumerConfig, commonConfig }) {
  const driverOpt = DRIVER_OPTIONS.find(d => d.value === values.driver) || DRIVER_OPTIONS[0]
  const out = [
    `name: ${driverOpt.label}`,
    `driverClass: ${driverOpt.driverClass}`,
    ``,
    `replicationFactor: ${values.replicationFactor}`,
    `reset: ${values.reset}`,
  ]
  out.push('', ...buildSection('commonConfig',   commonConfig))
  out.push('', ...buildSection('topicConfig',    topicConfig))
  out.push('', ...buildSection('producerConfig', producerConfig))
  out.push('', ...buildSection('consumerConfig', consumerConfig))
  return out.join('\n')
}

export function deriveProtocol(cluster) {
  if (!cluster) return ''
  if (cluster.tls_enabled && cluster.sasl_enabled) return 'SASL_SSL'
  if (cluster.tls_enabled) return 'SSL'
  if (cluster.sasl_enabled) return 'SASL_PLAINTEXT'
  return 'PLAINTEXT'
}

export function buildCommonConfigFromCluster(cluster) {
  if (!cluster?.bootstrap_servers) return []
  const rows = [{ key: 'bootstrap.servers', value: cluster.bootstrap_servers }]
  const protocol = deriveProtocol(cluster)
  if (protocol) rows.push({ key: 'security.protocol', value: protocol })
  if (cluster.sasl_enabled && cluster.sasl_mechanism) {
    rows.push({ key: 'sasl.mechanism', value: cluster.sasl_mechanism })
    const loginModule = cluster.sasl_mechanism === 'PLAIN'
      ? 'org.apache.kafka.common.security.plain.PlainLoginModule'
      : 'org.apache.kafka.common.security.scram.ScramLoginModule'
    if (cluster.sasl_username) {
      rows.push({
        key: 'sasl.jaas.config',
        value: `${loginModule} required username="${cluster.sasl_username}" password="${cluster.sasl_password || ''}";`,
      })
    }
  }
  return rows
}
```

- [ ] **Step 4: Run tests to confirm they all pass**

```bash
cd /Users/cnelson/sandbox/omb_k8s/aws_private/omb-k8s/control-plane/frontend
npm test -- driverFormUtils 2>&1 | tail -15
```

Expected: all tests in `driverFormUtils.test.js` pass.

- [ ] **Step 5: Run the full test suite to confirm no regressions**

```bash
npm test 2>&1 | tail -8
```

Expected: all 37 existing tests + new driverFormUtils tests pass.

- [ ] **Step 6: Commit**

```bash
cd /Users/cnelson/sandbox/omb_k8s/aws_private/omb-k8s
git add control-plane/frontend/src/lib/driverFormUtils.js \
        control-plane/frontend/src/lib/__tests__/driverFormUtils.test.js
git commit -m "feat: extract driver form utilities to driverFormUtils.js with tests"
```

---

## Task 2: Rewrite DriverForm.jsx with section-based state model

**Files:**
- Modify: `control-plane/frontend/src/components/DriverForm.jsx`

**Context:** Replace the flat named-field form with four `PropertySection` components plus the two scalar fields (`replicationFactor`, `reset`). Default values must be identical to the current form:

| Section | Default rows |
|---------|-------------|
| Topic Config | `retention.ms=3600000` |
| Producer Config | `acks=all`, `linger.ms=1`, `batch.size=131072` |
| Consumer Config | `auto.offset.reset=earliest`, `enable.auto.commit=false` |
| Common Config | seeded from cluster settings (same logic as before) |

The exported `buildDriverYaml` keeps the same import path but new signature — existing callers receive the YAML string via `onChange`, not by calling `buildDriverYaml` directly, so the signature change is safe.

- [ ] **Step 1: Read the current DriverForm.jsx to understand exactly what it exports and renders**

Read `/Users/cnelson/sandbox/omb_k8s/aws_private/omb-k8s/control-plane/frontend/src/components/DriverForm.jsx` in full.

- [ ] **Step 2: Replace DriverForm.jsx with the new implementation**

Write the complete new file at `control-plane/frontend/src/components/DriverForm.jsx`:

```jsx
import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { useSettings } from '../context/SettingsContext.jsx'
import {
  DRIVER_OPTIONS,
  parseDriverYaml,
  buildDriverYaml,
  buildCommonConfigFromCluster,
  deriveProtocol,
} from '../lib/driverFormUtils.js'

export { buildDriverYaml }

const DEFAULTS = {
  driver: 'redpanda',
  replicationFactor: 3,
  reset: true,
}

const DEFAULT_TOPIC_CONFIG = [
  { key: 'retention.ms', value: '3600000' },
]

const DEFAULT_PRODUCER_CONFIG = [
  { key: 'acks',      value: 'all'    },
  { key: 'linger.ms', value: '1'      },
  { key: 'batch.size',value: '131072' },
]

const DEFAULT_CONSUMER_CONFIG = [
  { key: 'auto.offset.reset',  value: 'earliest' },
  { key: 'enable.auto.commit', value: 'false'    },
]

function PropertySection({ title, rows, onChange }) {
  function addRow() {
    onChange([...rows, { key: '', value: '' }])
  }
  function updateRow(i, field, val) {
    onChange(rows.map((r, idx) => idx === i ? { ...r, [field]: val } : r))
  }
  function removeRow(i) {
    onChange(rows.filter((_, idx) => idx !== i))
  }
  return (
    <div style={{ marginBottom: 16 }}>
      <div className="section-label">{title}</div>
      {rows.map((row, i) => (
        <div key={i} style={{ display: 'grid', gridTemplateColumns: '1fr 1fr auto', gap: 8, marginBottom: 6 }}>
          <input
            className="form-input"
            placeholder="key"
            value={row.key}
            onChange={e => updateRow(i, 'key', e.target.value)}
          />
          <input
            className="form-input"
            placeholder="value"
            value={row.value}
            onChange={e => updateRow(i, 'value', e.target.value)}
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

export default function DriverForm({ onChange, initialYaml }) {
  const { settings, hasClusterConfig } = useSettings()
  const cluster = settings?.cluster

  const {
    values: parsedValues,
    topicConfig:    pt,
    producerConfig: pp,
    consumerConfig: pc,
    commonConfig:   pcc,
  } = parseDriverYaml(initialYaml)

  const [values,         setValues]         = useState({ ...DEFAULTS, ...parsedValues })
  const [topicConfig,    setTopicConfig]    = useState(pt.length  > 0 ? pt  : DEFAULT_TOPIC_CONFIG)
  const [producerConfig, setProducerConfig] = useState(pp.length  > 0 ? pp  : DEFAULT_PRODUCER_CONFIG)
  const [consumerConfig, setConsumerConfig] = useState(pc.length  > 0 ? pc  : DEFAULT_CONSUMER_CONFIG)
  const [commonConfig,   setCommonConfig]   = useState(pcc.length > 0 ? pcc : buildCommonConfigFromCluster(cluster))

  useEffect(() => {
    onChange?.(buildDriverYaml(values, { topicConfig, producerConfig, consumerConfig, commonConfig }))
  }, [values, topicConfig, producerConfig, consumerConfig, commonConfig])

  function setField(key, val) {
    setValues(prev => ({ ...prev, [key]: val }))
  }

  return (
    <div>
      {/* Connection info — read-only, from Settings */}
      <div className="connection-box">
        <div className="section-label">Connection — from Settings</div>
        {hasClusterConfig ? (
          <div className="connection-grid">
            <span style={{ color: 'var(--color-text-muted)' }}>Brokers</span>
            <span>{cluster.bootstrap_servers}</span>
            <span style={{ color: 'var(--color-text-muted)' }}>Protocol</span>
            <span>{deriveProtocol(cluster)}</span>
            {cluster.sasl_enabled && <>
              <span style={{ color: 'var(--color-text-muted)' }}>Mechanism</span>
              <span>{cluster.sasl_mechanism}</span>
              <span style={{ color: 'var(--color-text-muted)' }}>Username</span>
              <span>{cluster.sasl_username || '—'}</span>
            </>}
          </div>
        ) : (
          <div style={{ fontSize: 13, color: 'var(--color-warning)' }}>
            No cluster configured —{' '}
            <Link to="/settings" style={{ color: 'var(--color-primary)' }}>go to Settings</Link>
            {' '}to add broker details.
          </div>
        )}
      </div>

      {/* Scalar fields */}
      <div className="section-label">Per-Run Settings</div>

      <div className="form-row">
        <div className="form-group">
          <label className="form-label">Driver</label>
          <select
            className="form-select"
            value={values.driver}
            onChange={e => setField('driver', e.target.value)}
          >
            {DRIVER_OPTIONS.map(o => (
              <option key={o.value} value={o.value}>{o.label}</option>
            ))}
          </select>
        </div>
        <div className="form-group">
          <label className="form-label">Replication Factor</label>
          <input
            type="number"
            className="form-input"
            value={values.replicationFactor}
            onChange={e => setField('replicationFactor', Number(e.target.value))}
          />
        </div>
      </div>

      <div className="form-group">
        <div className="toggle-row">
          <label className="toggle">
            <input
              type="checkbox"
              checked={values.reset}
              onChange={e => setField('reset', e.target.checked)}
            />
            <span className="toggle-slider" />
          </label>
          <span className="toggle-label">Reset Topic on Startup</span>
          <span
            className="chart-info-icon"
            title="When enabled, OMB deletes and recreates the benchmark topic before each run. This ensures a clean slate with no residual messages or offsets. Disable to reuse an existing topic — useful for consumer backlog tests or when you want to avoid topic recreation overhead between sweep runs."
          >i</span>
        </div>
      </div>

      {/* Sectioned config */}
      <PropertySection title="Topic Config"    rows={topicConfig}    onChange={setTopicConfig} />
      <PropertySection title="Producer Config" rows={producerConfig} onChange={setProducerConfig} />
      <PropertySection title="Consumer Config" rows={consumerConfig} onChange={setConsumerConfig} />
      <PropertySection title="Common Config"   rows={commonConfig}   onChange={setCommonConfig} />
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

- [ ] **Step 4: Run full test suite**

```bash
npm test 2>&1 | tail -8
```

Expected: all tests pass (the driverFormUtils tests from Task 1 remain green; existing tests unaffected).

- [ ] **Step 5: Commit**

```bash
cd /Users/cnelson/sandbox/omb_k8s/aws_private/omb-k8s
git add control-plane/frontend/src/components/DriverForm.jsx
git commit -m "feat: refactor DriverForm to sectioned key/value property inputs"
```

---

## Self-Review

**Spec coverage:**

| Requirement | Covered by |
|-------------|------------|
| Topic Config section → topicConfig YAML | Task 2 `PropertySection` + `buildSection('topicConfig', ...)` |
| Producer Config section → producerConfig YAML | Task 2 `PropertySection` + `buildSection('producerConfig', ...)` |
| Consumer Config section → consumerConfig YAML | Task 2 `PropertySection` + `buildSection('consumerConfig', ...)` |
| Common Config section → commonConfig YAML | Task 2 `PropertySection` + `buildSection('commonConfig', ...)` |
| Unlabeled section: replicationFactor discrete field | Task 2 number input in "Per-Run Settings" |
| Unlabeled section: reset discrete toggle | Task 2 toggle checkbox in "Per-Run Settings" |
| Key text input per row | Task 2 `PropertySection` key `<input>` |
| Value text input per row | Task 2 `PropertySection` value `<input>` |
| Delete button per row | Task 2 `PropertySection` × `<button>` |
| [+ Add property] per section | Task 2 `PropertySection` addRow button |
| Block scalar output `key: \| \n  k=v` | Task 1 `buildSection` → `"${name}: |"` + indented lines |
| Empty string sentinel `key: ""` | Task 1 `buildSection` → `"${name}: \"\""` when 0 rows |
| Default retention.ms=3600000 | Task 2 `DEFAULT_TOPIC_CONFIG` |
| Default acks=all, linger.ms=1, batch.size=131072 | Task 2 `DEFAULT_PRODUCER_CONFIG` |
| Default auto.offset.reset=earliest, enable.auto.commit=false | Task 2 `DEFAULT_CONSUMER_CONFIG` |
| Default replicationFactor=3, reset=true | Task 2 `DEFAULTS` |
| Common config seeded from cluster settings | Task 2 `buildCommonConfigFromCluster(cluster)` on init |
| Existing YAML loads into correct sections | Task 1 `parseDriverYaml` round-trip test; Task 2 `parseDriverYaml(initialYaml)` on init |

**Placeholder scan:** None found — all steps contain complete code.

**Type consistency:**
- `parseDriverYaml` returns `{ values, topicConfig, producerConfig, consumerConfig, commonConfig }` — matches destructuring in `DriverForm.jsx` as `{ values: parsedValues, topicConfig: pt, producerConfig: pp, consumerConfig: pc, commonConfig: pcc }`
- `buildDriverYaml(values, { topicConfig, producerConfig, consumerConfig, commonConfig })` — matches the `useEffect` call in `DriverForm.jsx`
- `PropertySection` receives `rows: {key: string, value: string}[]` and `onChange: (rows) => void` — matches all four `setState` setters passed as `onChange`
- `DEFAULT_*_CONFIG` arrays contain `{key: string, value: string}` objects — matches `PropertySection` and `buildDriverYaml` input type
- `buildCommonConfigFromCluster` returns `{key: string, value: string}[]` — tested in Task 1, consumed in Task 2 `useState` initializer
