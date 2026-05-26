import { useEffect, useMemo, useState } from 'react'
import { Link, useLocation } from 'react-router-dom'
import { listRuns, createRun, getRun } from '../api.js'
import { useWorker } from '../context/WorkerContext.jsx'
import { useSettings } from '../context/SettingsContext.jsx'
import DriverForm from '../components/DriverForm.jsx'
import WorkloadForm, { parseWorkloadYaml } from '../components/WorkloadForm.jsx'

function StatusBadge({ status }) {
  return <span className={`badge badge-${status}`}>{status}</span>
}

function fmt(n, unit = '') {
  if (n == null) return '—'
  return n.toLocaleString(undefined, { maximumFractionDigits: 1 }) + (unit ? ' ' + unit : '')
}

function RunCreateForm({ onCreated, initialWorkloadContent, initialWorkloadName, initialDriverContent }) {
  const { workersReady, status } = useWorker()
  const { hasClusterConfig } = useSettings()
  const [name, setName] = useState(initialWorkloadName ? `Run — ${initialWorkloadName}` : '')
  const [driverYaml, setDriverYaml] = useState('')
  const [workloadYaml, setWorkloadYaml] = useState(initialWorkloadContent || '')
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState(null)

  const projectedLoad = useMemo(() => {
    const { values } = parseWorkloadYaml(workloadYaml)
    const totalMsgSec = Number(values.producerRate) || 0
    const totalMBSec = (totalMsgSec * (Number(values.messageSize) || 0)) / 1_048_576
    const perProducerCount = (Number(values.producersPerTopic) || 1) * (Number(values.topics) || 1)
    return {
      totalMsgSec,
      totalMBSec,
      perProducerMsgSec: perProducerCount > 0 ? totalMsgSec / perProducerCount : 0,
      perProducerMBSec: perProducerCount > 0 ? totalMBSec / perProducerCount : 0,
    }
  }, [workloadYaml])

  const notReady = !workersReady
  const blockMessage = status
    ? `Waiting for workers: ${status.ready}/${status.desired} ready. Please wait before starting a run.`
    : 'Worker status unknown. Please wait…'
  const noCluster = !hasClusterConfig

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
      const run = await createRun({
        name: name.trim() || null,
        driver_content: driverYaml,
        workload_content: workloadYaml,
      })
      onCreated(run)
    } catch (e) {
      setError(e.message)
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <form onSubmit={handleSubmit}>
      <div className="card mb-20">
        <div className="card-header">
          <h2>New Run</h2>
          <button type="submit" className="btn btn-launch" disabled={submitting || notReady || noCluster}>
            {submitting ? <><span className="spinner" /> Launching…</> : 'Launch Run'}
          </button>
        </div>
        <div className="card-body">
          {notReady && status && <div className="alert alert-warning mb-16">{blockMessage}</div>}
          {noCluster && (
            <div className="alert alert-warning mb-16">
              Configure cluster settings before launching a run.
            </div>
          )}
          <div className="form-group">
            <label className="form-label">Run Name (optional)</label>
            <input className="form-input" value={name} onChange={e => setName(e.target.value)}
              placeholder="e.g. 1KB 100-partition baseline" />
          </div>
          <hr className="divider" />
          <div className="projected-load" style={{ marginBottom: 16 }}>
            <div className="projected-load-title">Projected Load</div>
            <div className="projected-load-grid">
              <span>Total</span>
              <span>{projectedLoad.totalMsgSec.toLocaleString()} msg/s</span>
              <span>{projectedLoad.totalMBSec.toFixed(1)} MB/s</span>
              <span>Per producer</span>
              <span>{projectedLoad.perProducerMsgSec.toLocaleString(undefined, { maximumFractionDigits: 0 })} msg/s</span>
              <span>{projectedLoad.perProducerMBSec.toFixed(1)} MB/s</span>
            </div>
          </div>
          <div className="form-row" style={{ alignItems: 'start', gap: 24 }}>
            <div style={{ border: '1px solid var(--color-border)', borderRadius: 'var(--radius)', padding: '16px' }}>
              <div style={{ fontSize: 14, fontWeight: 600, marginBottom: 12 }}>Driver</div>
              <DriverForm onChange={setDriverYaml} initialYaml={initialDriverContent} />
            </div>
            <div style={{ border: '1px solid var(--color-border)', borderRadius: 'var(--radius)', padding: '16px' }}>
              <div style={{ fontSize: 14, fontWeight: 600, marginBottom: 12 }}>Workload</div>
              <WorkloadForm initialYaml={initialWorkloadContent} onChange={setWorkloadYaml} />
            </div>
          </div>
          {error && <div className="alert alert-error mt-16">{error}</div>}
        </div>
      </div>
    </form>
  )
}

export default function RunsPage() {
  const location = useLocation()
  const [runs, setRuns] = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)
  const [showForm, setShowForm] = useState(!!location.state?.workloadContent)
  // null = fetch in flight, false = no fetch needed, object = fetched
  const [lastRun, setLastRun] = useState(
    location.state?.workloadContent ? false : null
  )

  const initialWorkloadContent = location.state?.workloadContent || ''
  const initialWorkloadName = location.state?.workloadName || ''

  async function loadRuns() {
    try {
      const data = await listRuns()
      setRuns(data)
      setError(null)
    } catch (e) {
      setError(e.message)
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => { loadRuns() }, [])

  async function handleShowForm() {
    if (showForm) { setShowForm(false); return }
    setShowForm(true)
    if (runs.length > 0) {
      try {
        const run = await getRun(runs[0].id)
        setLastRun(run)
      } catch {
        setLastRun(false)  // fetch failed — show form with defaults
      }
    } else {
      setLastRun(false)  // no prior runs — show form immediately
    }
  }

  function handleCreated(run) {
    setShowForm(false)
    setLastRun(null)  // reset so next open fetches the just-completed run
    loadRuns()
  }

  const defaultDriverContent  = initialWorkloadContent ? '' : (lastRun?.driver_config  || '')
  const defaultWorkloadContent = initialWorkloadContent || lastRun?.workload_config || ''

  return (
    <div>
      <div className="page-header">
        <h1 className="page-title">Benchmark Runs</h1>
        <button className="btn btn-primary" onClick={handleShowForm}>
          + New Run
        </button>
      </div>

      {showForm && lastRun !== null && (
        <RunCreateForm
          onCreated={handleCreated}
          initialWorkloadContent={defaultWorkloadContent}
          initialWorkloadName={initialWorkloadName}
          initialDriverContent={defaultDriverContent}
        />
      )}

      {loading ? (
        <div className="text-muted">Loading runs…</div>
      ) : error ? (
        <div className="alert alert-error">{error}</div>
      ) : runs.length === 0 ? (
        <div className="card">
          <div className="empty-state">
            <p>No runs yet. Launch one above.</p>
          </div>
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
                <th className="num">Pub Rate (msg/s)</th>
                <th className="num">Pub P99 (ms)</th>
                <th className="num">E2E P99 (ms)</th>
                <th className="num">Consume Rate</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {runs.map(run => (
                <tr key={run.id}>
                  <td>#{run.id}</td>
                  <td>{run.name || <span className="text-muted">—</span>}</td>
                  <td><StatusBadge status={run.status} /></td>
                  <td className="text-small text-muted">
                    {run.started_at ? new Date(run.started_at).toLocaleString() : '—'}
                  </td>
                  <td className="num">{fmt(run.publish_rate_avg)}</td>
                  <td className="num">{fmt(run.publish_latency_p99)}</td>
                  <td className="num">{fmt(run.end_to_end_latency_p99)}</td>
                  <td className="num">{fmt(run.consume_rate_avg)}</td>
                  <td>
                    <Link to={`/runs/${run.id}`} className="btn btn-secondary btn-sm">View</Link>
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
