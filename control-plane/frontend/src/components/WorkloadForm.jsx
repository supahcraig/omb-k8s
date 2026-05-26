import { useEffect, useState } from 'react'

const DEFAULTS = {
  topics: 1,
  partitionsPerTopic: 100,
  messageSize: 1024,
  subscriptionsPerTopic: 1,
  producersPerTopic: 4,
  consumerPerSubscription: 1,
  producerRate: 100000,
  consumerBacklogSizeGB: 0,
  testDurationMinutes: 5,
  warmupDurationMinutes: 1,
  useRandomizedPayloads: false,
  randomizedPayloadPoolSize: '',
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
    let parsed
    if (val === 'true') parsed = true
    else if (val === 'false') parsed = false
    else { const num = Number(val); parsed = !isNaN(num) && val !== '' ? num : val }
    if (KNOWN_KEYS.includes(key)) {
      values[key] = parsed
    } else if (key === 'payloadFile') {
      // auto-injected at job creation time — never treat as a custom field
    } else {
      customFields.push({ key, value: val })
    }
  }
  return { values, customFields }
}

export function buildWorkloadYaml(values, customFields) {
  const lines = KNOWN_KEYS
    .filter(k => {
      const v = values[k]
      if (v === '' || v === undefined) return false
      if (k === 'useRandomizedPayloads' && v === false) return false
      if (k === 'randomizedPayloadPoolSize' && !values.useRandomizedPayloads) return false
      return true
    })
    .map(k => `${k}: ${values[k]}`)

  // The Job init container generates /payload/payload.data with exactly messageSize random bytes.
  if (!lines.some(l => l.startsWith('payloadFile:'))) {
    lines.push('payloadFile: /payload/payload.data')
  }

  for (const { key, value } of customFields) {
    if (key.trim()) lines.push(`${key}: ${value}`)
  }
  return lines.join('\n')
}

export default function WorkloadForm({ initialYaml, onChange }) {
  const parsed = parseWorkloadYaml(initialYaml || '')
  const [values, setValues] = useState(parsed.values)
  const [customFields, setCustomFields] = useState(parsed.customFields)

  useEffect(() => {
    onChange?.(buildWorkloadYaml(values, customFields))
  }, [values, customFields])

  function setField(key, val) {
    setValues(prev => {
      const coerced = typeof val === 'boolean' ? val : (val === '' ? '' : (isNaN(Number(val)) ? val : Number(val)))
      const next = { ...prev, [key]: coerced }
      if (key === 'useRandomizedPayloads' && val === true && !prev.randomizedPayloadPoolSize) {
        next.randomizedPayloadPoolSize = 1000
      }
      return next
    })
  }

  function addCustomField() {
    setCustomFields(prev => [...prev, { key: '', value: '' }])
  }

  function updateCustomField(i, field, val) {
    setCustomFields(prev => prev.map((f, idx) => idx === i ? { ...f, [field]: val } : f))
  }

  function removeCustomField(i) {
    setCustomFields(prev => prev.filter((_, idx) => idx !== i))
  }

  function numInput(key, label, hint) {
    return (
      <div className="form-group" style={{ marginBottom: 12 }}>
        <label className="form-label">{label}</label>
        <input
          type="number"
          className="form-input"
          value={values[key]}
          onChange={e => setField(key, e.target.value)}
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
      {numInput('subscriptionsPerTopic', 'Subscriptions / Topic')}

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

      <div className="section-label" style={{ marginTop: 8 }}>Payload</div>
      <div className="form-group" style={{ marginBottom: 12 }}>
        <label style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer' }}>
          <input
            type="checkbox"
            checked={!!values.useRandomizedPayloads}
            onChange={e => setField('useRandomizedPayloads', e.target.checked)}
          />
          <span className="form-label" style={{ marginBottom: 0 }}>Randomize payload per message</span>
        </label>
        <span className="form-hint">When off, OMB reuses a single random byte array for every message.</span>
      </div>
      {values.useRandomizedPayloads && (
        <div className="form-group" style={{ marginBottom: 12 }}>
          <label className="form-label">Payload pool size</label>
          <input
            type="number"
            className="form-input"
            value={values.randomizedPayloadPoolSize}
            onChange={e => setField('randomizedPayloadPoolSize', e.target.value)}
            min={1}
          />
          <span className="form-hint">Number of distinct payload buffers to generate at startup.</span>
        </div>
      )}

      {customFields.length > 0 && (
        <div style={{ marginBottom: 12 }}>
          {customFields.map((f, i) => (
            <div key={i} style={{ display: 'grid', gridTemplateColumns: '1fr 1fr auto', gap: 8, marginBottom: 6 }}>
              <input className="form-input" placeholder="key" value={f.key}
                onChange={e => updateCustomField(i, 'key', e.target.value)} />
              <input className="form-input" placeholder="value" value={f.value}
                onChange={e => updateCustomField(i, 'value', e.target.value)} />
              <button type="button" className="btn btn-danger btn-sm" onClick={() => removeCustomField(i)}>×</button>
            </div>
          ))}
        </div>
      )}
      <button type="button" className="btn btn-secondary btn-sm" onClick={addCustomField}>
        + Add field
      </button>
    </div>
  )
}
