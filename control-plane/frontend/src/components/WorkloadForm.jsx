import { useEffect, useState } from 'react'
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
  const def = WORKLOAD_KNOWN_PROP_OPTIONS[rowKey]
  const knownOption = def && (value === '' || (def.options?.includes(value) ?? true)) ? def : null
  const knownType   = WORKLOAD_KNOWN_PROP_TYPES[rowKey]
  const hint        = WORKLOAD_PROP_HINTS[rowKey]

  if (knownOption?.type === 'toggle') {
    return (
      <label className="toggle" style={{ marginTop: 2 }}>
        <input
          type="checkbox"
          checked={value === 'true'}
          onChange={e => onChange(e.target.checked ? 'true' : 'false')}
        />
        <span className="toggle-slider" />
      </label>
    )
  }

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

function WorkloadSection({ title, rows, onChange, isRowDisabled }) {
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
        const disabled = isRowDisabled?.(row) ?? false
        return (
          <div key={row._id} style={{
            display: 'grid', gridTemplateColumns: '1fr 1fr auto', gap: 8, marginBottom: 6,
            opacity: disabled ? 0.35 : 1,
            pointerEvents: disabled ? 'none' : undefined,
          }}>
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
        )
      })}
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
  const payloadBase = ppa.length > 0 ? wrap(ppa) : hasYaml ? [] : DEFAULT_PAYLOAD_ROWS.map(r => makeRow(r.key, r.value))
  if (!payloadBase.find(r => r.key === 'randomizedPayloadPoolSize')) {
    payloadBase.push(makeRow('randomizedPayloadPoolSize', '1000'))
  }
  const [payload,  setPayload]  = useState(payloadBase)
  const [extra,    setExtra]    = useState(wrap(pex))

  const isRandomized = payload.find(r => r.key === 'useRandomizedPayloads')?.value === 'true'

  useEffect(() => {
    const activePayload = payload.filter(r => r.key !== 'randomizedPayloadPoolSize' || isRandomized)
    const allRows = [...topology, ...load, ...timing, ...activePayload, ...extra]
    onChange?.(buildWorkloadYaml(allRows))
  }, [topology, load, timing, payload, extra])

  return (
    <div>
      <WorkloadSection title="Topology"   rows={topology} onChange={setTopology} />
      <WorkloadSection title="Load"       rows={load}     onChange={setLoad} />
      <WorkloadSection title="Timing"     rows={timing}   onChange={setTiming} />
      <WorkloadSection
        title="Payload"
        rows={payload}
        onChange={setPayload}
        isRowDisabled={row => row.key === 'randomizedPayloadPoolSize' && !isRandomized}
      />
      <WorkloadSection title="Additional" rows={extra}    onChange={setExtra} />
    </div>
  )
}
