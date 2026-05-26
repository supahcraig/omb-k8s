import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { listSweeps, createSweep } from '../api.js'
import { useWorker } from '../context/WorkerContext.jsx'
import { useSettings } from '../context/SettingsContext.jsx'
import DriverForm from '../components/DriverForm.jsx'
import WorkloadForm from '../components/WorkloadForm.jsx'

const WORKLOAD_AXIS_FIELDS = [
  'partitionsPerTopic', 'messageSize', 'producerRate', 'producersPerTopic',
  'topics', 'subscriptionsPerTopic', 'consumerPerSubscription',
  'consumerBacklogSizeGB', 'testDurationMinutes', 'warmupDurationMinutes',
]

const DRIVER_AXIS_FIELDS = [
  'replicationFactor', 'producerConfig.acks', 'producerConfig.linger.ms',
  'producerConfig.batch.size', 'consumerConfig.auto.offset.reset',
]

function SweepCreateForm({ onCreated }) {
  const { workersReady, status } = useWorker()
  const { hasClusterConfig } = useSettings()
  const [name, setName] = useState('')
  const [driverYaml, setDriverYaml] = useState('')
  const [workloadYaml, setWorkloadYaml] = useState('')
  const [cooldown, setCooldown] = useState(60)
  const [axes, setAxes] = useState([{ field: 'partitionsPerTopic', type: 'workload', values: '50,100,200', custom: false }])
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState(null)

  const notReady = !workersReady
  const noCluster = !hasClusterConfig

  function addAxis() {
    setAxes(prev => [...prev, { field: 'partitionsPerTopic', type: 'workload', values: '', custom: false }])
  }

  function removeAxis(i) {
    setAxes(prev => prev.filter((_, idx) => idx !== i))
  }

  function updateAxis(i, updates) {
    setAxes(prev => prev.map((a, idx) => idx === i ? { ...a, ...updates } : a))
  }

  function parseAxisValues(str) {
    return str.split(',').map(v => v.trim()).filter(Boolean).map(v => {
      const n = Number(v); return isNaN(n) ? v : n
    })
  }

  const totalRuns = axes.reduce((acc, { values }) => {
    const n = values.split(',').filter(v => v.trim()).length
    return acc * (n || 1)
  }, 1)

  async function handleSubmit(e) {
    e.preventDefault()
    if (notReady || noCluster) return
    if (!name.trim()) { setError('Name is required.'); return }

    const workload_parameter_axes = {}
    const driver_parameter_axes = {}
    for (const { field, type, values } of axes) {
      const key = field.trim()
      if (!key) { setError('All axis field names must be filled in.'); return }
      const parsed = parseAxisValues(values)
      if (!parsed.length) { setError(`Values for "${key}" cannot be empty.`); return }
      if (type === 'driver') {
        driver_parameter_axes[key] = parsed
      } else {
        workload_parameter_axes[key] = parsed
      }
    }

    setSubmitting(true)
    setError(null)
    try {
      await createSweep({
        name: name.trim(),
        driver_base_content: driverYaml,
        workload_content: workloadYaml,
        cooldown_seconds: Number(cooldown),
        workload_parameter_axes,
        driver_parameter_axes,
      })
      onCreated()
    } catch (e) {
      setError(e.message)
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <div className="card mb-20">
      <div className="card-header"><h2>New Parameter Sweep</h2></div>
      <div className="card-body">
        {notReady && status && (
          <div className="alert alert-warning mb-16">
            {`Waiting for workers: ${status.ready}/${status.desired} ready. Please wait before starting a sweep.`}
          </div>
        )}
        {noCluster && (
          <div className="alert alert-warning mb-16">Configure cluster settings before launching a sweep.</div>
        )}
        <form onSubmit={handleSubmit}>
          <div className="form-row">
            <div className="form-group">
              <label className="form-label">Sweep Name</label>
              <input className="form-input" value={name} onChange={e => setName(e.target.value)}
                placeholder="e.g. Partition count sweep" />
            </div>
            <div className="form-group">
              <label className="form-label">Cooldown Between Runs (seconds)</label>
              <input className="form-input" type="number" value={cooldown}
                onChange={e => setCooldown(e.target.value)} min={0} />
            </div>
          </div>

          <div className="form-group">
            <label className="form-label">Parameter Axes ({totalRuns} run{totalRuns !== 1 ? 's' : ''} total)</label>
            {axes.map((axis, i) => (
              <div key={i} style={{ display: 'grid', gridTemplateColumns: '140px 1fr 1fr auto', gap: 8, marginBottom: 8, alignItems: 'start' }}>
                <select className="form-select" value={axis.type}
                  onChange={e => updateAxis(i, {
                    type: e.target.value,
                    field: e.target.value === 'driver' ? DRIVER_AXIS_FIELDS[0] : WORKLOAD_AXIS_FIELDS[0],
                    custom: false,
                  })}>
                  <option value="workload">Workload</option>
                  <option value="driver">Driver</option>
                </select>
                {axis.custom ? (
                  <input className="form-input" placeholder="Field name"
                    value={axis.field} onChange={e => updateAxis(i, { field: e.target.value })} />
                ) : (
                  <select className="form-select" value={axis.field}
                    onChange={e => {
                      if (e.target.value === '__custom__') {
                        updateAxis(i, { custom: true, field: '' })
                      } else {
                        updateAxis(i, { field: e.target.value })
                      }
                    }}>
                    {(axis.type === 'driver' ? DRIVER_AXIS_FIELDS : WORKLOAD_AXIS_FIELDS).map(f => (
                      <option key={f} value={f}>{f}</option>
                    ))}
                    <option value="__custom__">Custom…</option>
                  </select>
                )}
                <input className="form-input" placeholder="Comma-separated values"
                  value={axis.values} onChange={e => updateAxis(i, { values: e.target.value })} />
                <button type="button" className="btn btn-danger btn-sm"
                  onClick={() => removeAxis(i)} disabled={axes.length === 1}>×</button>
              </div>
            ))}
            <button type="button" className="btn btn-secondary btn-sm mt-8" onClick={addAxis}>
              + Add axis
            </button>
          </div>

          <hr className="divider" />
          <div className="form-row" style={{ alignItems: 'start' }}>
            <div>
              <div style={{ fontSize: 14, fontWeight: 600, marginBottom: 12 }}>Driver (base)</div>
              <DriverForm onChange={setDriverYaml} />
            </div>
            <div>
              <div style={{ fontSize: 14, fontWeight: 600, marginBottom: 12 }}>Workload (base)</div>
              <WorkloadForm onChange={setWorkloadYaml} />
            </div>
          </div>

          {error && <div className="alert alert-error">{error}</div>}
          <button type="submit" className="btn btn-primary mt-16"
            disabled={submitting || notReady || noCluster}>
            {submitting ? <><span className="spinner" /> Launching…</> : `Launch Sweep (${totalRuns} run${totalRuns !== 1 ? 's' : ''})`}
          </button>
        </form>
      </div>
    </div>
  )
}

function SweepStatusBadge({ status }) {
  const cls = status === 'completed' ? 'badge-completed'
    : status === 'running' ? 'badge-running'
    : status === 'cancelled' ? 'badge-cancelled'
    : 'badge-pending'
  return <span className={`badge ${cls}`}>{status}</span>
}

export default function SweepsPage() {
  const [sweeps, setSweeps] = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)
  const [showForm, setShowForm] = useState(false)

  async function load() {
    try {
      const data = await listSweeps()
      setSweeps(data)
      setError(null)
    } catch (e) {
      setError(e.message)
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => { load() }, [])

  function handleCreated() {
    setShowForm(false)
    load()
  }

  return (
    <div>
      <div className="page-header">
        <h1 className="page-title">Parameter Sweeps</h1>
        <button className="btn btn-primary" onClick={() => setShowForm(f => !f)}>
          {showForm ? 'Cancel' : '+ New Sweep'}
        </button>
      </div>

      {showForm && <SweepCreateForm onCreated={handleCreated} />}

      {loading ? (
        <div className="text-muted">Loading sweeps…</div>
      ) : error ? (
        <div className="alert alert-error">{error}</div>
      ) : sweeps.length === 0 ? (
        <div className="card">
          <div className="empty-state"><p>No sweeps yet. Launch one above.</p></div>
        </div>
      ) : (
        <div className="card">
          <table className="data-table">
            <thead>
              <tr>
                <th>ID</th>
                <th>Name</th>
                <th>Status</th>
                <th>Started</th>
                <th>Completed</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {sweeps.map(s => (
                <tr key={s.id}>
                  <td>#{s.id}</td>
                  <td>{s.name}</td>
                  <td><SweepStatusBadge status={s.status} /></td>
                  <td className="text-small text-muted">
                    {s.started_at ? new Date(s.started_at).toLocaleString() : '—'}
                  </td>
                  <td className="text-small text-muted">
                    {s.completed_at ? new Date(s.completed_at).toLocaleString() : '—'}
                  </td>
                  <td>
                    <Link to={`/sweeps/${s.id}`} className="btn btn-secondary btn-sm">View</Link>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}
