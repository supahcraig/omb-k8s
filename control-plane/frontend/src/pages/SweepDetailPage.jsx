import { useEffect, useState } from 'react'
import { useParams, Link } from 'react-router-dom'
import { getSweep, getSweepRuns, cancelSweep } from '../api.js'

function StatusBadge({ status }) {
  const cls = {
    running: 'badge-running', completed: 'badge-completed',
    failed: 'badge-failed', pending: 'badge-pending', cancelled: 'badge-cancelled',
  }[status] || 'badge-pending'
  return <span className={`badge ${cls}`}>{status}</span>
}

function fmt(n, digits = 1) {
  if (n == null) return '—'
  return n.toLocaleString(undefined, { maximumFractionDigits: digits })
}

function parseParams(jsonStr) {
  if (!jsonStr) return {}
  try { return JSON.parse(jsonStr) } catch { return {} }
}

export default function SweepDetailPage() {
  const { id } = useParams()
  const [sweep, setSweep] = useState(null)
  const [runs, setRuns] = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)

  async function load() {
    try {
      const [sw, rs] = await Promise.all([getSweep(id), getSweepRuns(id)])
      setSweep(sw)
      setRuns(rs)
      setError(null)
    } catch (e) {
      setError(e.message)
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    load()
    // Poll while running
    const iv = setInterval(() => {
      if (sweep?.status === 'running') load()
    }, 5000)
    return () => clearInterval(iv)
  }, [id])

  async function handleCancel() {
    if (!confirm('Cancel this sweep?')) return
    try {
      await cancelSweep(id)
      load()
    } catch (e) {
      alert(e.message)
    }
  }

  if (loading) return <div className="text-muted mt-20">Loading sweep…</div>
  if (error) return <div className="alert alert-error">{error}</div>
  if (!sweep) return null

  // Detect all parameter keys used across runs for the comparison table
  const paramKeys = Array.from(new Set(
    runs.flatMap(r => Object.keys(parseParams(r.sweep_params)))
  ))

  return (
    <div>
      <div className="page-header">
        <div>
          <Link to="/sweeps" className="btn btn-secondary btn-sm">← Back to Sweeps</Link>
          <h1 className="page-title mt-8">{sweep.name}</h1>
          <div className="flex items-center gap-8 mt-4">
            <StatusBadge status={sweep.status} />
            {sweep.started_at && (
              <span className="text-muted text-small">
                Started {new Date(sweep.started_at).toLocaleString()}
              </span>
            )}
          </div>
        </div>
        {sweep.status === 'running' && (
          <button className="btn btn-danger" onClick={handleCancel}>Cancel Sweep</button>
        )}
      </div>

      <div className="card">
        <div className="card-header">
          <h3>Run Comparison — {runs.length} run{runs.length !== 1 ? 's' : ''}</h3>
        </div>
        {runs.length === 0 ? (
          <div className="empty-state"><p>No runs yet.</p></div>
        ) : (
          <table className="data-table">
            <thead>
              <tr>
                <th>Run</th>
                {paramKeys.map(k => <th key={k}>{k}</th>)}
                <th>Status</th>
                <th className="num">Pub Rate (msg/s)</th>
                <th className="num">Pub P99 (ms)</th>
                <th className="num">E2E P99 (ms)</th>
                <th className="num">Consume Rate</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {runs.map(run => {
                const params = parseParams(run.sweep_params)
                const m = run.metrics
                return (
                  <tr key={run.id}>
                    <td>#{run.id}</td>
                    {paramKeys.map(k => (
                      <td key={k}>{params[k] ?? '—'}</td>
                    ))}
                    <td><StatusBadge status={run.status} /></td>
                    <td className="num">{fmt(m?.publish_rate_avg)}</td>
                    <td className="num">{fmt(m?.publish_latency_p99)}</td>
                    <td className="num">{fmt(m?.end_to_end_latency_p99)}</td>
                    <td className="num">{fmt(m?.consume_rate_avg)}</td>
                    <td>
                      <Link to={`/runs/${run.id}`} className="btn btn-secondary btn-sm">View</Link>
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        )}
      </div>
    </div>
  )
}
