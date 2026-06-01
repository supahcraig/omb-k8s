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
  { key: 'acks',       value: 'all'    },
  { key: 'linger.ms',  value: '1'      },
  { key: 'batch.size', value: '131072' },
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
