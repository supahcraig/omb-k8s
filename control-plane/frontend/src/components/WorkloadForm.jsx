import { useEffect, useState } from 'react'

const DEFAULTS = {
  topics: 1,
  partitionsPerTopic: 100,
  messageSize: 1024,
  subscriptionCount: 1,
  producersPerTopic: 4,
  consumerPerSubscription: 1,
  producerRate: 100000,
  consumerBacklogSizeGB: 0,
  testDurationMinutes: 5,
  warmupDurationMinutes: 1,
}

const KNOWN_KEYS = Object.keys(DEFAULTS)

export function parseWorkloadYaml(yamlStr) {
  const values = { ...DEFAULTS }
  const customFields = []
  if (!yamlStr) return { values, customFields }

  for (const line of yamlStr.split('\n')) {
    const match = line.match(/^(\w+):\s*(.+)$/)
    if (!match) continue
    const [, key, rawVal] = match
    const val = rawVal.trim()
    const num = Number(val)
    const parsed = !isNaN(num) && val !== '' ? num : val
    if (KNOWN_KEYS.includes(key)) {
      values[key] = parsed
    } else {
      customFields.push({ key, value: val })
    }
  }
  return { values, customFields }
}

export function buildWorkloadYaml(values, customFields) {
  const lines = KNOWN_KEYS
    .filter(k => values[k] !== '' && values[k] !== undefined)
    .map(k => `${k}: ${values[k]}`)

  for (const { key, value } of customFields) {
    if (key.trim()) lines.push(`${key}: ${value}`)
  }
  return lines.join('\n')
}

export default function WorkloadForm({ initialYaml, onChange }) {
  const parsed = parseWorkloadYaml(initialYaml || '')
  const [values, setValues] = useState(parsed.values)
  const [customFields, setCustomFields] = useState(parsed.customFields)
  const [yamlOverride, setYamlOverride] = useState(null)

  useEffect(() => {
    const yaml = yamlOverride !== null ? yamlOverride : buildWorkloadYaml(values, customFields)
    onChange?.(yaml)
  }, [values, customFields, yamlOverride])

  function setField(key, val) {
    setYamlOverride(null)
    setValues(prev => ({ ...prev, [key]: val === '' ? '' : (isNaN(Number(val)) ? val : Number(val)) }))
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

  const previewYaml = yamlOverride !== null ? yamlOverride : buildWorkloadYaml(values, customFields)
  const isOverride = yamlOverride !== null

  const totalMsgSec = Number(values.producerRate) || 0
  const totalMBSec = (totalMsgSec * (Number(values.messageSize) || 0)) / 1_048_576
  const perProducerCount = (Number(values.producersPerTopic) || 1) * (Number(values.topics) || 1)
  const perProducerMsgSec = perProducerCount > 0 ? totalMsgSec / perProducerCount : 0
  const perProducerMBSec = perProducerCount > 0 ? totalMBSec / perProducerCount : 0

  function numInput(key, label, hint) {
    return (
      <div className="form-group" style={{ marginBottom: 12 }}>
        <label className="form-label">{label}</label>
        <input
          type="number"
          className="form-input"
          value={values[key]}
          onChange={e => setField(key, e.target.value)}
          disabled={isOverride}
        />
        {hint && <span className="form-hint">{hint}</span>}
      </div>
    )
  }

  return (
    <div>
      <div className="section-label">Topology</div>
      <div className="form-row">
        {numInput('topics', 'Topics')}
        {numInput('partitionsPerTopic', 'Partitions / Topic')}
      </div>
      <div className="form-row">
        {numInput('producersPerTopic', 'Producers / Topic')}
        {numInput('consumerPerSubscription', 'Consumers / Subscription')}
      </div>
      {numInput('subscriptionCount', 'Subscription Count')}

      <div className="section-label" style={{ marginTop: 8 }}>Load</div>
      <div className="form-row">
        {numInput('messageSize', 'Message Size', 'bytes')}
        {numInput('producerRate', 'Producer Rate', 'msg/s')}
      </div>
      {numInput('consumerBacklogSizeGB', 'Consumer Backlog', 'GB')}

      <div className="section-label" style={{ marginTop: 8 }}>Timing</div>
      <div className="form-row">
        {numInput('warmupDurationMinutes', 'Warmup', 'min')}
        {numInput('testDurationMinutes', 'Test Duration', 'min')}
      </div>

      <div className="projected-load">
        <div className="projected-load-title">Projected Load</div>
        <div className="projected-load-grid">
          <span>Total</span>
          <span>{totalMsgSec.toLocaleString()} msg/s</span>
          <span>{totalMBSec.toFixed(1)} MB/s</span>
          <span>Per producer</span>
          <span>{perProducerMsgSec.toLocaleString(undefined, { maximumFractionDigits: 0 })} msg/s</span>
          <span>{perProducerMBSec.toFixed(1)} MB/s</span>
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

      <details open>
        <summary style={{ cursor: 'pointer', fontSize: 13, fontWeight: 600, marginBottom: 8, userSelect: 'none' }}>
          YAML Preview {isOverride && <span style={{ color: 'var(--color-warning)', fontSize: 11 }}>(manually overridden)</span>}
        </summary>
        <textarea
          className="form-textarea tall"
          value={previewYaml}
          onChange={e => setYamlOverride(e.target.value)}
          style={{ fontFamily: 'monospace', fontSize: 12 }}
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
