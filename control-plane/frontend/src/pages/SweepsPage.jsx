import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { listSweeps } from '../api.js'

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

  return (
    <div>
      <div className="page-header">
        <h1 className="page-title">Parameter Sweeps</h1>
        <Link to="/sweeps/new" className="btn btn-primary">+ New Sweep</Link>
      </div>

      {loading ? (
        <div className="text-muted">Loading sweeps…</div>
      ) : error ? (
        <div className="alert alert-error">{error}</div>
      ) : sweeps.length === 0 ? (
        <div className="card">
          <div className="empty-state"><p>No sweeps yet. <Link to="/sweeps/new">Launch one.</Link></p></div>
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
