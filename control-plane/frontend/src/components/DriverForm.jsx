import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { useSettings } from '../context/SettingsContext.jsx'

const DRIVER_OPTIONS = [
  { label: 'Redpanda', value: 'redpanda', driverClass: 'io.openmessaging.benchmark.driver.redpanda.RedpandaBenchmarkDriver' },
  { label: 'Kafka',    value: 'kafka',    driverClass: 'io.openmessaging.benchmark.driver.kafka.KafkaBenchmarkDriver' },
]

const DEFAULTS = {
  driver: 'redpanda',
  replicationFactor: 3,
  retentionMs: '',
  acks: 'all',
  lingerMs: 1,
  batchSize: 131072,
  autoOffsetReset: 'earliest',
  autoCommit: false,
}

function fmtRetentionMs(val) {
  const ms = Number(val)
  if (val === '' || val == null) return ''
  if (ms === -1) return 'unlimited'
  if (ms <= 0) return ''
  if (ms < 60_000)     return `${+(ms / 1_000).toFixed(1)} sec`
  if (ms < 3_600_000)  return `${+(ms / 60_000).toFixed(1)} min`
  if (ms < 86_400_000) return `${+(ms / 3_600_000).toFixed(1)} hr`
  return `${+(ms / 86_400_000).toFixed(2)} days`
}

function deriveProtocol(cluster) {
  if (!cluster) return ''
  if (cluster.tls_enabled && cluster.sasl_enabled) return 'SASL_SSL'
  if (cluster.tls_enabled) return 'SSL'
  if (cluster.sasl_enabled) return 'SASL_PLAINTEXT'
  return 'PLAINTEXT'
}

export function buildDriverYaml(values, customFields, cluster) {
  const driverOpt = DRIVER_OPTIONS.find(d => d.value === values.driver) || DRIVER_OPTIONS[0]

  const commonLines = []
  if (cluster?.bootstrap_servers) {
    commonLines.push(`bootstrap.servers=${cluster.bootstrap_servers}`)
    const protocol = deriveProtocol(cluster)
    if (protocol) commonLines.push(`security.protocol=${protocol}`)
    if (cluster.sasl_enabled && cluster.sasl_mechanism) {
      commonLines.push(`sasl.mechanism=${cluster.sasl_mechanism}`)
      const loginModule = cluster.sasl_mechanism === 'PLAIN'
        ? 'org.apache.kafka.common.security.plain.PlainLoginModule'
        : 'org.apache.kafka.common.security.scram.ScramLoginModule'
      if (cluster.sasl_username) {
        commonLines.push(`sasl.jaas.config=${loginModule} required username="${cluster.sasl_username}" password="${cluster.sasl_password || ''}";`)
      }
    }
  }

  const out = [
    `name: ${driverOpt.label}`,
    `driverClass: ${driverOpt.driverClass}`,
    ``,
    `replicationFactor: ${values.replicationFactor}`,
  ]

  if (commonLines.length) {
    out.push(``, `commonConfig: |`)
    commonLines.forEach(l => out.push(`  ${l}`))
  }

  if (values.retentionMs !== '' && values.retentionMs != null) {
    out.push(``, `topicConfig: |`)
    out.push(`  retention.ms=${values.retentionMs}`)
  } else {
    out.push(``, `topicConfig: ""`)
  }
  out.push(``, `producerConfig: |`)
  out.push(`  acks=${values.acks}`)
  out.push(`  linger.ms=${values.lingerMs}`)
  out.push(`  batch.size=${values.batchSize}`)

  out.push(``, `consumerConfig: |`)
  out.push(`  auto.offset.reset=${values.autoOffsetReset}`)
  out.push(`  enable.auto.commit=${values.autoCommit}`)

  for (const { key, value } of customFields) {
    if (key.trim()) out.push(`${key}: ${value}`)
  }

  return out.join('\n')
}

export default function DriverForm({ onChange, initialYaml }) {
  const { settings, hasClusterConfig } = useSettings()
  const cluster = settings?.cluster

  const [values, setValues] = useState({ ...DEFAULTS })
  const [customFields, setCustomFields] = useState([])
  const [yamlOverride, setYamlOverride] = useState(initialYaml || null)

  useEffect(() => {
    const yaml = yamlOverride !== null ? yamlOverride : buildDriverYaml(values, customFields, cluster)
    onChange?.(yaml)
  }, [values, customFields, yamlOverride, cluster])

  function setField(key, val) {
    setYamlOverride(null)
    setValues(prev => ({ ...prev, [key]: val }))
  }

  function addCustomField() {
    setCustomFields(prev => [...prev, { key: '', value: '' }])
  }

  function updateCustomField(i, field, val) {
    setYamlOverride(null)
    setCustomFields(prev => prev.map((f, idx) => idx === i ? { ...f, [field]: val } : f))
  }

  function removeCustomField(i) {
    setCustomFields(prev => prev.filter((_, idx) => idx !== i))
  }

  const isOverride = yamlOverride !== null
  const previewYaml = isOverride ? yamlOverride : buildDriverYaml(values, customFields, cluster)

  return (
    <div>
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

      <div className="section-label">Per-Run Settings</div>

      <div className="form-row">
        <div className="form-group">
          <label className="form-label">Driver</label>
          <select className="form-select" value={values.driver}
            onChange={e => setField('driver', e.target.value)} disabled={isOverride}>
            {DRIVER_OPTIONS.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
          </select>
        </div>
        <div className="form-group">
          <label className="form-label">Replication Factor</label>
          <input type="number" className="form-input" value={values.replicationFactor}
            onChange={e => setField('replicationFactor', Number(e.target.value))} disabled={isOverride} />
        </div>
      </div>

      <div className="form-group">
        <label className="form-label">retention.ms</label>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <input type="number" className="form-input" value={values.retentionMs}
            placeholder="broker default"
            onChange={e => setField('retentionMs', e.target.value)} disabled={isOverride} />
          {fmtRetentionMs(values.retentionMs) && (
            <span style={{ fontSize: 13, color: 'var(--color-primary)', whiteSpace: 'nowrap', fontWeight: 600 }}>
              ≈ {fmtRetentionMs(values.retentionMs)}
            </span>
          )}
        </div>
        <span className="form-hint">-1 for unlimited. Empty = broker default.</span>
      </div>

      <div className="form-row">
        <div className="form-group">
          <label className="form-label">acks</label>
          <select className="form-select" value={values.acks}
            onChange={e => setField('acks', e.target.value)} disabled={isOverride}>
            <option value="all">all</option>
            <option value="1">1</option>
            <option value="0">0</option>
          </select>
        </div>
        <div className="form-group">
          <label className="form-label">linger.ms</label>
          <input type="number" className="form-input" value={values.lingerMs}
            onChange={e => setField('lingerMs', Number(e.target.value))} disabled={isOverride} />
        </div>
      </div>

      <div className="form-row">
        <div className="form-group">
          <label className="form-label">batch.size</label>
          <input type="number" className="form-input" value={values.batchSize}
            onChange={e => setField('batchSize', Number(e.target.value))} disabled={isOverride} />
        </div>
        <div className="form-group">
          <label className="form-label">auto.offset.reset</label>
          <select className="form-select" value={values.autoOffsetReset}
            onChange={e => setField('autoOffsetReset', e.target.value)} disabled={isOverride}>
            <option value="earliest">earliest</option>
            <option value="latest">latest</option>
          </select>
        </div>
      </div>

      <div className="form-group">
        <div className="toggle-row">
          <label className="toggle">
            <input type="checkbox" checked={values.autoCommit}
              onChange={e => setField('autoCommit', e.target.checked)} disabled={isOverride} />
            <span className="toggle-slider" />
          </label>
          <span className="toggle-label">enable.auto.commit</span>
        </div>
      </div>

      {customFields.length > 0 && (
        <div style={{ marginBottom: 12 }}>
          {customFields.map((f, i) => (
            <div key={i} style={{ display: 'grid', gridTemplateColumns: '1fr 1fr auto', gap: 8, marginBottom: 6 }}>
              <input className="form-input" placeholder="key" value={f.key}
                onChange={e => updateCustomField(i, 'key', e.target.value)} disabled={isOverride} />
              <input className="form-input" placeholder="value" value={f.value}
                onChange={e => updateCustomField(i, 'value', e.target.value)} disabled={isOverride} />
              <button type="button" className="btn btn-danger btn-sm" onClick={() => removeCustomField(i)}>×</button>
            </div>
          ))}
        </div>
      )}
      <button type="button" className="btn btn-secondary btn-sm" onClick={addCustomField} disabled={isOverride}
        style={{ marginBottom: 16 }}>
        + Add field
      </button>

      <details open style={{ width: '100%' }}>
        <summary style={{ cursor: 'pointer', fontSize: 13, fontWeight: 600, marginBottom: 8, userSelect: 'none' }}>
          YAML Preview {isOverride && <span style={{ color: 'var(--color-warning)', fontSize: 11 }}>(manually overridden)</span>}
        </summary>
        <textarea
          className="form-textarea tall"
          value={previewYaml}
          onChange={e => setYamlOverride(e.target.value)}
        />
        {isOverride && (
          <button type="button" className="btn btn-secondary btn-sm" onClick={() => setYamlOverride(null)}
            style={{ marginTop: 6 }}>
            Reset to form
          </button>
        )}
      </details>
    </div>
  )
}
