import { useEffect, useMemo, useState } from 'react'
import { Link, useLocation, useNavigate } from 'react-router-dom'
import { listRuns, createRun, getRun, createSweep, getSweepRuns } from '../api.js'
import { useWorker } from '../context/WorkerContext.jsx'
import { useSettings } from '../context/SettingsContext.jsx'
import DriverForm from '../components/DriverForm.jsx'
import WorkloadForm, { parseWorkloadYaml } from '../components/WorkloadForm.jsx'
import LibraryDrawer from '../components/LibraryDrawer.jsx'

const SWEEP_STORAGE_KEY = 'omb_last_sweep'

const WORKLOAD_AXIS_FIELDS = [
  'partitionsPerTopic', 'messageSize', 'producerRate', 'producersPerTopic',
  'topics', 'subscriptionsPerTopic', 'consumerPerSubscription',
  'consumerBacklogSizeGB', 'testDurationMinutes', 'warmupDurationMinutes',
]
const DRIVER_AXIS_FIELDS = [
  'replicationFactor', 'producerConfig.acks', 'producerConfig.linger.ms',
  'producerConfig.batch.size', 'consumerConfig.auto.offset.reset',
]

function loadSavedSweep() {
  try {
    const s = localStorage.getItem(SWEEP_STORAGE_KEY)
    if (!s) return null
    const parsed = JSON.parse(s)
    // Migrate old format: single axes array with a type field → separate arrays
    if (parsed?.axes && !parsed?.workloadAxes) {
      const workloadAxes = []
      const driverAxes   = []
      for (const a of parsed.axes) {
        const values = Array.isArray(a.values)
          ? a.values
          : String(a.values || '').split(',').map(v => v.trim()).filter(Boolean)
              .map(v => { const n = Number(v); return isNaN(n) ? v : n })
        const axis = { field: a.field, values, custom: !!a.custom }
        if (a.type === 'driver') driverAxes.push(axis)
        else workloadAxes.push(axis)
      }
      return { ...parsed, workloadAxes, driverAxes }
    }
    const norm = arr => (arr || []).map(a => ({ ...a, values: Array.isArray(a.values) ? a.values : [] }))
    return { ...parsed, workloadAxes: norm(parsed.workloadAxes), driverAxes: norm(parsed.driverAxes) }
  } catch { return null }
}

// ---------------------------------------------------------------------------
// Sub-components
// ---------------------------------------------------------------------------

function PanelBadge({ color, children, style }) {
  return (
    <div style={{
      display: 'inline-block', marginBottom: 12, padding: '3px 10px',
      borderRadius: 12, background: color + '22', border: `1px solid ${color}55`,
      color, fontSize: 11, fontWeight: 700, letterSpacing: '0.06em', textTransform: 'uppercase',
      ...style,
    }}>
      {children}
    </div>
  )
}

function PanelHeader({ color, label, onBrowse }) {
  return (
    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
      <PanelBadge color={color} style={{ marginBottom: 0 }}>{label}</PanelBadge>
      <button type="button" className="btn btn-secondary btn-sm"
        style={{ fontSize: 11, padding: '2px 9px' }}
        onClick={onBrowse}>
        Browse library
      </button>
    </div>
  )
}

function ChipInput({ values, onChange }) {
  const [inputVal, setInputVal] = useState('')

  function commit(raw) {
    const v = raw.trim()
    if (!v) return
    const n = Number(v)
    onChange([...values, isNaN(n) ? v : n])
    setInputVal('')
  }

  function handleKeyDown(e) {
    if (e.key === 'Enter' || e.key === ',') { e.preventDefault(); commit(inputVal) }
    else if (e.key === 'Backspace' && inputVal === '') onChange(values.slice(0, -1))
  }

  return (
    <div className="chip-input" onClick={e => e.currentTarget.querySelector('input')?.focus()}>
      {values.map((v, i) => (
        <span key={i} className="chip-value">
          {v}
          <button type="button" className="chip-remove"
            onClick={() => onChange(values.filter((_, j) => j !== i))}>×</button>
        </span>
      ))}
      <input className="chip-input-field" value={inputVal}
        onChange={e => setInputVal(e.target.value)}
        onKeyDown={handleKeyDown}
        onBlur={() => commit(inputVal)}
        placeholder={values.length === 0 ? 'Type value, press Enter' : ''} />
    </div>
  )
}

function AxisPanel({ axes, fields, color, title, onUpdate, onRemove, onAdd }) {
  return (
    <div style={{
      background: 'var(--color-surface)',
      border: '1px solid var(--color-border)',
      borderTop: `3px solid ${color}`,
      borderRadius: 'var(--radius)',
      padding: 16,
    }}>
      <PanelBadge color={color}>{title} Axes</PanelBadge>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        {axes.map((axis, i) => (
          <div key={i} style={{ display: 'grid', gridTemplateColumns: '1fr 1fr auto', gap: 8, alignItems: 'start' }}>
            {axis.custom ? (
              <input className="form-input" placeholder="e.g. producerConfig.acks"
                value={axis.field} onChange={e => onUpdate(i, { field: e.target.value })} />
            ) : (
              <select className="form-select" value={axis.field}
                onChange={e => e.target.value === '__custom__'
                  ? onUpdate(i, { custom: true, field: '' })
                  : onUpdate(i, { field: e.target.value })}>
                {fields.map(f => <option key={f} value={f}>{f}</option>)}
                <option value="__custom__">Custom…</option>
              </select>
            )}
            <ChipInput values={axis.values} onChange={vals => onUpdate(i, { values: vals })} />
            <button type="button" className="btn btn-danger btn-sm"
              onClick={() => onRemove(i)}>×</button>
          </div>
        ))}
      </div>
      <button type="button" className="btn btn-secondary btn-sm mt-8" onClick={onAdd}>
        + Add axis
      </button>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

export default function NewRunPage() {
  const location = useLocation()
  const navigate = useNavigate()
  const { pools } = useWorker()
  const { hasClusterConfig } = useSettings()

  const fromWorkloadLibrary    = !!location.state?.workloadContent
  const fromDriverLibrary      = !!location.state?.driverContent
  const fromLibrary            = fromWorkloadLibrary  // only skip last-run fetch for workload library
  const initialWorkloadContent = location.state?.workloadContent || ''
  const initialWorkloadName    = location.state?.workloadName || location.state?.driverName || ''

  const [poolId, setPoolId]           = useState(null)
  const [name, setName]               = useState(initialWorkloadName ? `Run — ${initialWorkloadName}` : '')
  const [driverYaml, setDriverYaml]   = useState('')
  const [workloadYaml, setWorkloadYaml] = useState(initialWorkloadContent)
  const [submitting, setSubmitting]   = useState(false)
  const [error, setError]             = useState(null)
  const [lastRun, setLastRun]         = useState(fromLibrary ? false : null)

  // Library drawer
  const [drawerType, setDrawerType]           = useState(null)
  const [driverFormKey, setDriverFormKey]     = useState(0)
  const [workloadFormKey, setWorkloadFormKey] = useState(0)
  const [driverInitOverride, setDriverInitOverride]     = useState(null)
  const [workloadInitOverride, setWorkloadInitOverride] = useState(null)

  // Sweep state
  const saved = useMemo(() => loadSavedSweep(), [])
  const hasAxesValues = !!(
    saved?.workloadAxes?.some(a => a.values.length > 0) ||
    saved?.driverAxes?.some(a => a.values.length > 0)
  )
  const [sweepEnabled, setSweepEnabled] = useState(!!location.state?.enableSweep)
  const [cooldown, setCooldown]         = useState(saved?.cooldown ?? 60)
  const [workloadAxes, setWorkloadAxes] = useState(
    saved?.workloadAxes?.length ? saved.workloadAxes
      : [{ field: WORKLOAD_AXIS_FIELDS[0], values: [], custom: false }]
  )
  const [driverAxes, setDriverAxes] = useState(
    saved?.driverAxes?.length ? saved.driverAxes
      : [{ field: DRIVER_AXIS_FIELDS[0], values: [], custom: false }]
  )

  useEffect(() => {
    if (fromLibrary) return
    listRuns()
      .then(runs => {
        if (runs.length === 0) { setLastRun(false); return }
        return getRun(runs[0].id).then(setLastRun).catch(() => setLastRun(false))
      })
      .catch(() => setLastRun(false))
  }, [])

  // Auto-select the pool if exactly one ready pool exists.
  useEffect(() => {
    const ready = pools.filter(p => p.status === 'ready')
    if (ready.length === 1) setPoolId(prev => prev ?? ready[0].id)
  }, [pools])

  const initialDriverContent = fromDriverLibrary
    ? location.state.driverContent
    : fromWorkloadLibrary ? ''
    : (lastRun?.driver_config || '')
  const initialWorkload = fromWorkloadLibrary ? initialWorkloadContent : (lastRun?.workload_config || '')

  const projectedLoad = useMemo(() => {
    const { values } = parseWorkloadYaml(workloadYaml)
    const totalMsgSec          = Number(values.producerRate)       || 0
    const msgSize              = Number(values.messageSize)        || 1024
    const totalMBSec           = (totalMsgSec * msgSize) / 1_048_576
    const subscriptionsPerTopic = Number(values.subscriptionsPerTopic) || 1
    const consumeMsgSec        = totalMsgSec * subscriptionsPerTopic
    const consumeMBSec         = consumeMsgSec * msgSize / 1_048_576
    const perProducerCount     = (Number(values.producersPerTopic) || 1) * (Number(values.topics) || 1)
    const totalPartitions      = (Number(values.topics) || 1) * (Number(values.partitionsPerTopic) || 1)

    const batchSizeMatch = driverYaml.match(/batch\.size=(\d+)/)
    const lingerMsMatch  = driverYaml.match(/linger\.ms=(\d+)/)
    const batchSize = batchSizeMatch ? Number(batchSizeMatch[1]) : 131072
    const lingerMs  = lingerMsMatch  ? Number(lingerMsMatch[1])  : 1

    const perPartitionMsgSec = totalPartitions > 0 ? totalMsgSec / totalPartitions : 0
    const perPartitionMBSec  = totalPartitions > 0 ? totalMBSec  / totalPartitions : 0
    const msgsPerBatch       = Math.floor(batchSize / Math.max(1, msgSize))
    const msFillBatch        = perPartitionMsgSec > 0 ? (msgsPerBatch / perPartitionMsgSec) * 1000 : Infinity
    const mbPerBatchActual   = msFillBatch > lingerMs && perPartitionMsgSec > 0
      ? (perPartitionMsgSec * (lingerMs / 1000) * msgSize) / 1_048_576
      : null

    const warmupMin = Number(values.warmupDurationMinutes) || 0
    const testMin   = Number(values.testDurationMinutes)   || 0

    return {
      totalMsgSec, totalMBSec,
      consumeMsgSec, consumeMBSec,
      perProducerMsgSec: perProducerCount > 0 ? totalMsgSec / perProducerCount : 0,
      perProducerMBSec:  perProducerCount > 0 ? totalMBSec  / perProducerCount : 0,
      perPartitionMsgSec, perPartitionMBSec,
      msgsPerBatch, msFillBatch, lingerMs, mbPerBatchActual,
      warmupMin, testMin,
    }
  }, [workloadYaml, driverYaml])

  function fmtDur(totalMinutes) {
    const m = Math.round(totalMinutes)
    if (m <= 0) return '0m'
    const h = Math.floor(m / 60)
    const rem = m % 60
    if (h === 0) return `${rem}m`
    if (rem === 0) return `${h}h`
    return `${h}h ${rem}m`
  }

  const totalRuns = sweepEnabled
    ? [...workloadAxes, ...driverAxes].reduce((acc, { values }) => acc * (values.length || 1), 1)
    : 1

  const readyPools = pools.filter(p => p.status === 'ready')
  const notReady   = !poolId
  const noCluster  = !hasClusterConfig
  const blockMessage = readyPools.length === 0
    ? 'No worker pools are available. Create one on the Cluster page before launching a run.'
    : 'Select a worker pool below to launch a run.'

  function applyFromLibrary(content, entryName) {
    const hasContent = drawerType === 'driver' ? driverYaml.trim() : workloadYaml.trim()
    if (hasContent && !window.confirm(`Replace current ${drawerType} config with "${entryName}"?`)) return
    if (drawerType === 'driver') {
      setDriverInitOverride(content)
      setDriverYaml(content)
      setDriverFormKey(k => k + 1)
    } else {
      setWorkloadInitOverride(content)
      setWorkloadYaml(content)
      setWorkloadFormKey(k => k + 1)
    }
    setDrawerType(null)
  }

  async function handleSubmit(e) {
    e.preventDefault()
    if (notReady || noCluster) return
    if (!driverYaml.trim() || !workloadYaml.trim()) {
      setError('Driver and Workload configuration are required.')
      return
    }
    setSubmitting(true)
    setError(null)
    try {
      const hasAxes = sweepEnabled && [...workloadAxes, ...driverAxes].some(a => a.values.length > 0)
      if (hasAxes) {
        try {
          localStorage.setItem(SWEEP_STORAGE_KEY, JSON.stringify({
            name: name.trim(), cooldown: Number(cooldown), workloadAxes, driverAxes, driverYaml, workloadYaml,
          }))
        } catch {}
        const workload_parameter_axes = {}
        const driver_parameter_axes   = {}
        for (const { field, values } of workloadAxes) {
          const k = field.trim(); if (k && values.length > 0) workload_parameter_axes[k] = values
        }
        for (const { field, values } of driverAxes) {
          const k = field.trim(); if (k && values.length > 0) driver_parameter_axes[k] = values
        }
        const sweep = await createSweep({
          name: name.trim() || null,
          driver_base_content: driverYaml,
          workload_content:    workloadYaml,
          cooldown_seconds:    Number(cooldown),
          workload_parameter_axes,
          driver_parameter_axes,
          pool_id:             poolId,
        })
        const runs = await getSweepRuns(sweep.id)
        navigate(runs.length > 0 ? `/runs/${runs[0].id}` : `/sweeps/${sweep.id}`)
      } else {
        const run = await createRun({
          name: name.trim() || null,
          driver_content:   driverYaml,
          workload_content: workloadYaml,
          pool_id:          poolId,
        })
        navigate(`/runs/${run.id}`)
      }
    } catch (err) {
      setError(err.message)
    } finally {
      setSubmitting(false)
    }
  }

  if (lastRun === null) return <div className="text-muted mt-20">Loading…</div>

  const launchLabel = sweepEnabled && totalRuns > 1
    ? `Launch Sweep (${totalRuns} run${totalRuns !== 1 ? 's' : ''})`
    : 'Launch Run'

  return (
    <form onSubmit={handleSubmit} style={{ maxWidth: '1400px', margin: '0 auto' }}>
      {/* Header card */}
      <div className="card mb-20">
        <div className="card-header">
          <h2>New Run</h2>
          <button type="submit" className="btn btn-launch" disabled={submitting || notReady || noCluster}>
            {submitting ? <><span className="spinner" /> Launching…</> : launchLabel}
          </button>
        </div>
        <div className="card-body">
          {notReady && <div className="alert alert-warning mb-16">{blockMessage}</div>}
          {/* Pool selector */}
          <div className="form-group mb-16" style={{ width: 'fit-content' }}>
            <label className="form-label">Worker Pool <span style={{ color: '#ef4444' }}>*</span></label>
            {pools.length === 0 ? (
              <div className="text-muted text-small">Loading pools…</div>
            ) : (
              <select
                className="form-select"
                style={{ width: 'fit-content' }}
                value={poolId || ''}
                onChange={e => setPoolId(e.target.value || null)}
              >
                <option value="">— select a pool —</option>
                {pools.filter(p => p.status !== 'deleted').map(p => (
                  <option
                    key={p.id}
                    value={p.id}
                    disabled={p.status !== 'ready'}
                  >
                    {p.name} — {p.replicas} worker{p.replicas !== 1 ? 's' : ''}
                    {p.status !== 'ready' ? ` (${p.status})` : ''}
                  </option>
                ))}
              </select>
            )}
          </div>
          {noCluster && (
            <div className="alert alert-warning mb-16">
              Configure cluster settings before launching a run.{' '}
              <Link to="/settings" style={{ color: 'var(--color-primary)' }}>Go to Settings</Link>
            </div>
          )}
          <div className="form-group">
            <label className="form-label">Name (optional)</label>
            <input className="form-input" value={name} onChange={e => setName(e.target.value)}
              placeholder="e.g. 1KB 100-partition baseline" />
          </div>
          <hr className="divider" />
          <div className="projected-load" style={{ marginBottom: 0 }}>
            <div className="projected-load-title">Projected Load</div>
            <div className="projected-load-grid" style={{ gridTemplateColumns: '110px 1fr 1fr' }}>
              {/* Runtime estimate */}
              <span>Runtime</span>
              <span>{fmtDur(projectedLoad.warmupMin)} warmup + {fmtDur(projectedLoad.testMin)} bench</span>
              <span style={{ fontWeight: 600 }}>= {fmtDur(projectedLoad.warmupMin + projectedLoad.testMin)} / run</span>
              {sweepEnabled && totalRuns > 1 && (() => {
                const cooldownMin = Number(cooldown) / 60
                const totalMin = totalRuns * (projectedLoad.warmupMin + projectedLoad.testMin)
                               + (totalRuns - 1) * cooldownMin
                return (
                  <>
                    <span>Sweep total</span>
                    <span>{totalRuns} runs + {fmtDur((totalRuns - 1) * cooldownMin)} cooldown</span>
                    <span style={{ fontWeight: 600 }}>≈ {fmtDur(totalMin)}</span>
                  </>
                )
              })()}
              <span style={{ borderTop: '1px solid rgba(74,222,128,0.15)', paddingTop: 4, marginTop: 2 }}>Publish</span>
              <span>{projectedLoad.totalMsgSec.toLocaleString()} msg/s</span>
              <span>{projectedLoad.totalMBSec.toFixed(1)} MB/s</span>
              <span>Consume</span>
              <span>{projectedLoad.consumeMsgSec.toLocaleString()} msg/s</span>
              <span>{projectedLoad.consumeMBSec.toFixed(1)} MB/s</span>
              <span>Per producer</span>
              <span>{projectedLoad.perProducerMsgSec.toLocaleString(undefined, { maximumFractionDigits: 0 })} msg/s</span>
              <span>{projectedLoad.perProducerMBSec.toFixed(1)} MB/s</span>
              <span>Per partition</span>
              <span>{projectedLoad.perPartitionMsgSec.toLocaleString(undefined, { maximumFractionDigits: 1 })} msg/s</span>
              <span>{projectedLoad.perPartitionMBSec.toFixed(2)} MB/s</span>
              <span style={{ borderTop: '1px solid rgba(74,222,128,0.15)', paddingTop: 4, marginTop: 2 }}>Msgs / batch</span>
              <span style={{ borderTop: '1px solid rgba(74,222,128,0.15)', paddingTop: 4, marginTop: 2 }}>
                {projectedLoad.msgsPerBatch.toLocaleString()} msgs
              </span>
              <span style={{ borderTop: '1px solid rgba(74,222,128,0.15)', paddingTop: 4, marginTop: 2 }}>
                {projectedLoad.msFillBatch === Infinity
                  ? '—'
                  : `fills in ${projectedLoad.msFillBatch < 1 ? '<1' : projectedLoad.msFillBatch.toFixed(1)} ms`}
                <span style={{ opacity: 0.6, marginLeft: 6 }}>
                  (linger: {projectedLoad.lingerMs} ms
                  {projectedLoad.msFillBatch !== Infinity && (
                    projectedLoad.msFillBatch <= projectedLoad.lingerMs
                      ? ' — batch-full' : ' — linger-capped'
                  )})
                </span>
                {projectedLoad.mbPerBatchActual != null && (
                  <span style={{ opacity: 0.8, marginLeft: 6 }}>
                    · {projectedLoad.mbPerBatchActual < 1
                        ? `${(projectedLoad.mbPerBatchActual * 1024).toFixed(0)} kB/batch`
                        : `${projectedLoad.mbPerBatchActual.toFixed(2)} MB/batch`}
                  </span>
                )}
              </span>
            </div>
          </div>
          {error && <div className="alert alert-error mt-16">{error}</div>}
        </div>
      </div>

      {/* Parameter Sweep — above the driver/workload forms */}
      <div className="card mb-20">
        <div className="card-header">
          <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
            <label className="toggle-switch">
              <input type="checkbox" checked={sweepEnabled}
                onChange={e => setSweepEnabled(e.target.checked)} />
              <span className="toggle-track" />
            </label>
            <h3 style={{ margin: 0 }}>Parameter Sweep</h3>
            {sweepEnabled && totalRuns > 1 && (
              <span className="badge badge-running" style={{ fontSize: 11 }}>{totalRuns} runs</span>
            )}
          </div>
          {!sweepEnabled && (
            <span className="text-muted text-small">Enable to iterate over parameter combinations</span>
          )}
        </div>

        {sweepEnabled && (
          <div className="card-body">
            <div className="form-group" style={{ maxWidth: 220, marginBottom: 16 }}>
              <label className="form-label">Cooldown between runs (s)</label>
              <input className="form-input" type="number" min={0} value={cooldown}
                onChange={e => setCooldown(e.target.value)} />
            </div>

            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16 }}>
              <AxisPanel
                axes={driverAxes} fields={DRIVER_AXIS_FIELDS} color="#3b82f6" title="Driver"
                onUpdate={(i, u) => setDriverAxes(p => p.map((a, idx) => idx === i ? { ...a, ...u } : a))}
                onRemove={i => setDriverAxes(p => p.filter((_, idx) => idx !== i))}
                onAdd={() => setDriverAxes(p => [...p, { field: DRIVER_AXIS_FIELDS[0], values: [], custom: false }])}
              />
              <AxisPanel
                axes={workloadAxes} fields={WORKLOAD_AXIS_FIELDS} color="#10b981" title="Workload"
                onUpdate={(i, u) => setWorkloadAxes(p => p.map((a, idx) => idx === i ? { ...a, ...u } : a))}
                onRemove={i => setWorkloadAxes(p => p.filter((_, idx) => idx !== i))}
                onAdd={() => setWorkloadAxes(p => [...p, { field: WORKLOAD_AXIS_FIELDS[0], values: [], custom: false }])}
              />
            </div>
          </div>
        )}
      </div>

      {/* Driver + Workload 2×2 grid */}
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', columnGap: 20, rowGap: 6, marginBottom: 20 }}>
        <div style={{ background: 'var(--color-surface)', border: '1px solid var(--color-border)', borderTop: '3px solid #3b82f6', borderRadius: 'var(--radius)', padding: 16 }}>
          <PanelHeader color="#3b82f6" label="Driver" onBrowse={() => setDrawerType('driver')} />
          <DriverForm key={driverFormKey} onChange={setDriverYaml} initialYaml={driverInitOverride ?? initialDriverContent} />
        </div>
        <div style={{ background: 'var(--color-surface)', border: '1px solid var(--color-border)', borderTop: '3px solid #10b981', borderRadius: 'var(--radius)', padding: 16 }}>
          <PanelHeader color="#10b981" label="Workload" onBrowse={() => setDrawerType('workload')} />
          <WorkloadForm key={workloadFormKey} onChange={setWorkloadYaml} initialYaml={workloadInitOverride ?? initialWorkload} />
        </div>
        <div style={{ background: '#0d1018', border: '1px solid var(--color-border)', borderTop: '3px solid #3b82f6', borderRadius: 'var(--radius)', padding: 16, display: 'flex', flexDirection: 'column' }}>
          <PanelBadge color="#3b82f6">Driver YAML</PanelBadge>
          <textarea className="form-textarea"
            style={{ flex: 1, minHeight: 420, resize: 'vertical', fontFamily: 'monospace', fontSize: 12, background: '#0d1018' }}
            value={driverYaml} onChange={e => setDriverYaml(e.target.value)} />
        </div>
        <div style={{ background: '#0d1018', border: '1px solid var(--color-border)', borderTop: '3px solid #10b981', borderRadius: 'var(--radius)', padding: 16, display: 'flex', flexDirection: 'column' }}>
          <PanelBadge color="#10b981">Workload YAML</PanelBadge>
          <textarea className="form-textarea"
            style={{ flex: 1, minHeight: 420, resize: 'vertical', fontFamily: 'monospace', fontSize: 12, background: '#0d1018' }}
            value={workloadYaml} onChange={e => setWorkloadYaml(e.target.value)} />
        </div>
      </div>

      <LibraryDrawer
        type={drawerType ?? 'driver'}
        open={drawerType !== null}
        onClose={() => setDrawerType(null)}
        onApply={applyFromLibrary}
      />
    </form>
  )
}
