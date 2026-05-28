import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { listRuns } from '../api.js'

const BADGE_LABELS = { completed: '✓ completed', failed: '✗ failed' }
function StatusBadge({ status }) {
  return <span className={`badge badge-${status}`}>{BADGE_LABELS[status] ?? status}</span>
}

function fmt(n, unit = '') {
  if (n == null) return '—'
  return n.toLocaleString(undefined, { maximumFractionDigits: 1 }) + (unit ? ' ' + unit : '')
}

export default function RunsPage() {
  const [runs, setRuns] = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)

  useEffect(() => {
    listRuns()
      .then(data => { setRuns(data); setError(null) })
      .catch(e => setError(e.message))
      .finally(() => setLoading(false))
  }, [])

  return (
    <div>
      <div className="page-header">
        <h1 className="page-title">Benchmark Runs</h1>
      </div>

      {loading ? (
        <div className="text-muted">Loading runs…</div>
      ) : error ? (
        <div className="alert alert-error">{error}</div>
      ) : runs.length === 0 ? (
        <div className="card">
          <div className="empty-state">
            <p>No runs yet. <Link to="/runs/new">Start a new run.</Link></p>
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
                  <td style={{ whiteSpace: 'nowrap' }}><StatusBadge status={run.status} /></td>
                  <td className="text-small text-muted" style={{ whiteSpace: 'nowrap' }}>
                    {run.started_at ? new Date(run.started_at.endsWith('Z') ? run.started_at : run.started_at + 'Z').toLocaleString() : '—'}
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
