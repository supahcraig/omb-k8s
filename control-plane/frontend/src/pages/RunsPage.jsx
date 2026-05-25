import { useEffect, useState } from 'react'
import { Link, useLocation } from 'react-router-dom'
import { listRuns, createRun } from '../api.js'
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

function StatusBadge({ status }) {
  return <span className={`badge badge-${status}`}>{status}</span>
}

function fmt(n, unit = '') {
  if (n == null) return '—'
  return n.toLocaleString(undefined, { maximumFractionDigits: 1 }) + (unit ? ' ' + unit : '')
}

function RunCreateForm({ onCreated, initialWorkloadContent, initialWorkloadName }) {
  const { workersReady, status } = useWorker()
  const [name, setName] = useState(initialWorkloadName ? `Run — ${initialWorkloadName}` : '')
  const [driverYaml, setDriverYaml] = useState(DEFAULT_DRIVER)
  const [workloadYaml, setWorkloadYaml] = useState(initialWorkloadContent || '')
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState(null)

  const notReady = !workersReady
  const blockMessage = status
    ? `Waiting for workers: ${status.ready}/${status.desired} ready. Please wait before starting a run.`
    : 'Worker status unknown. Please wait…'

  async function handleSubmit(e) {
    e.preventDefault()
    if (notReady) return
    if (!driverYaml.trim() || !workloadYaml.trim()) {
      setError('Driver YAML and Workload YAML are both required.')
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
    <div className="card mb-20">
      <div className="card-header">
        <h2>New Run</h2>
      </div>
      <div className="card-body">
        {notReady && status && (
          <div className="alert alert-warning mb-16">{blockMessage}</div>
        )}
        <form onSubmit={handleSubmit}>
          <div className="form-group">
            <label className="form-label">Run Name (optional)</label>
            <input className="form-input" value={name} onChange={e => setName(e.target.value)}
              placeholder="e.g. 1KB 100-partition baseline" />
          </div>
          <div className="form-row">
            <div className="form-group">
              <label className="form-label">Driver YAML</label>
              <textarea className="form-textarea tall" value={driverYaml}
                onChange={e => setDriverYaml(e.target.value)} />
            </div>
            <div className="form-group">
              <label className="form-label">Workload YAML</label>
              <textarea className="form-textarea tall" value={workloadYaml}
                onChange={e => setWorkloadYaml(e.target.value)}
                placeholder="Paste workload YAML here or select from Workload Library" />
            </div>
          </div>
          {error && <div className="alert alert-error">{error}</div>}
          <button type="submit" className="btn btn-primary" disabled={submitting || notReady}>
            {submitting ? <><span className="spinner" /> Launching…</> : 'Launch Run'}
          </button>
        </form>
      </div>
    </div>
  )
}

export default function RunsPage() {
  const location = useLocation()
  const [runs, setRuns] = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)
  const [showForm, setShowForm] = useState(!!location.state?.workloadContent)

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

  function handleCreated(run) {
    setShowForm(false)
    loadRuns()
  }

  return (
    <div>
      <div className="page-header">
        <h1 className="page-title">Benchmark Runs</h1>
        <button className="btn btn-primary" onClick={() => setShowForm(f => !f)}>
          {showForm ? 'Cancel' : '+ New Run'}
        </button>
      </div>

      {showForm && (
        <RunCreateForm
          onCreated={handleCreated}
          initialWorkloadContent={initialWorkloadContent}
          initialWorkloadName={initialWorkloadName}
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
