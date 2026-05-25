import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { listSweeps, createSweep } from '../api.js'
import { useWorker } from '../context/WorkerContext.jsx'

const DEFAULT_DRIVER = `name: Kafka
driverClass: io.openmessaging.benchmark.driver.kafka.KafkaBenchmarkDriver

replicationFactor: 3

topicConfig:
  min.insync.replicas: 2

commonConfig: |
  bootstrap.servers=REPLACE_ME:9092
  security.protocol=SASL_SSL
  sasl.mechanism=SCRAM-SHA-256
  sasl.jaas.config=org.apache.kafka.common.security.scram.ScramLoginModule required username="REPLACE_ME" password="REPLACE_ME";

producerConfig: |
  acks=all
  linger.ms=1
  batch.size=131072

consumerConfig: |
  auto.offset.reset=earliest
  enable.auto.commit=false
`

function SweepCreateForm({ onCreated }) {
  const { workersReady, status } = useWorker()
  const [name, setName] = useState('')
  const [driverYaml, setDriverYaml] = useState(DEFAULT_DRIVER)
  const [workloadYaml, setWorkloadYaml] = useState('')
  const [cooldown, setCooldown] = useState(60)
  const [axes, setAxes] = useState([{ param: 'partitionsPerTopic', values: '50,100,200' }])
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState(null)

  const notReady = !workersReady
  const blockMessage = status
    ? `Waiting for workers: ${status.ready}/${status.desired} ready. Please wait before starting a sweep.`
    : 'Worker status unknown. Please wait…'

  function addAxis() {
    setAxes(prev => [...prev, { param: '', values: '' }])
  }

  function removeAxis(i) {
    setAxes(prev => prev.filter((_, idx) => idx !== i))
  }

  function updateAxis(i, field, val) {
    setAxes(prev => prev.map((a, idx) => idx === i ? { ...a, [field]: val } : a))
  }

  async function handleSubmit(e) {
    e.preventDefault()
    if (notReady) return
    if (!name.trim()) { setError('Sweep name is required.'); return }
    if (!driverYaml.trim() || !workloadYaml.trim()) {
      setError('Driver YAML and Workload YAML are required.')
      return
    }

    // Build parameter_axes
    const parameter_axes = {}
    for (const { param, values } of axes) {
      if (!param.trim()) { setError('All parameter axis names must be filled in.'); return }
      const parsed = values.split(',').map(v => v.trim()).filter(Boolean).map(v => {
        const n = Number(v)
        return isNaN(n) ? v : n
      })
      if (!parsed.length) { setError(`Values for "${param}" cannot be empty.`); return }
      parameter_axes[param.trim()] = parsed
    }

    setSubmitting(true)
    setError(null)
    try {
      const sweep = await createSweep({
        name: name.trim(),
        driver_base_content: driverYaml,
        workload_content: workloadYaml,
        cooldown_seconds: Number(cooldown),
        parameter_axes,
      })
      onCreated(sweep)
    } catch (e) {
      setError(e.message)
    } finally {
      setSubmitting(false)
    }
  }

  const totalRuns = axes.reduce((acc, { values }) => {
    const n = values.split(',').filter(v => v.trim()).length
    return acc * (n || 1)
  }, 1)

  return (
    <div className="card mb-20">
      <div className="card-header">
        <h2>New Parameter Sweep</h2>
      </div>
      <div className="card-body">
        {notReady && status && (
          <div className="alert alert-warning mb-16">{blockMessage}</div>
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
              <div key={i} className="param-axis-row">
                <input
                  className="form-input"
                  placeholder="Parameter name, e.g. partitionsPerTopic"
                  value={axis.param}
                  onChange={e => updateAxis(i, 'param', e.target.value)}
                />
                <input
                  className="form-input"
                  placeholder="Comma-separated values, e.g. 50,100,200"
                  value={axis.values}
                  onChange={e => updateAxis(i, 'values', e.target.value)}
                />
                <button type="button" className="btn btn-danger btn-sm" onClick={() => removeAxis(i)}
                  disabled={axes.length === 1}>
                  ×
                </button>
              </div>
            ))}
            <button type="button" className="btn btn-secondary btn-sm mt-8" onClick={addAxis}>
              + Add Parameter
            </button>
          </div>

          <div className="form-row">
            <div className="form-group">
              <label className="form-label">Driver YAML (base)</label>
              <textarea className="form-textarea tall" value={driverYaml}
                onChange={e => setDriverYaml(e.target.value)} />
            </div>
            <div className="form-group">
              <label className="form-label">Workload YAML (base)</label>
              <textarea className="form-textarea tall" value={workloadYaml}
                onChange={e => setWorkloadYaml(e.target.value)}
                placeholder="Base workload YAML — parameter values will override matching top-level keys" />
            </div>
          </div>

          {error && <div className="alert alert-error">{error}</div>}
          <button type="submit" className="btn btn-primary" disabled={submitting || notReady}>
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
