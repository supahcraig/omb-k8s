import { useEffect, useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { listSweeps } from '../api.js'

function SweepStatusBadge({ status }) {
  const cls = status === 'completed' ? 'badge-completed'
    : status === 'running' ? 'badge-running'
    : status === 'cancelled' ? 'badge-cancelled'
    : 'badge-pending'
  return <span className={`badge ${cls}`}>{status}</span>
}

function fmt(n, digits = 1) {
  if (n == null) return '—'
  return `${n.toLocaleString(undefined, { maximumFractionDigits: digits })} ms`
}

const COLS = [
  { key: 'id',               label: 'ID',           num: false },
  { key: 'name',             label: 'Name',         num: false },
  { key: 'status',           label: 'Status',       num: false },
  { key: 'started_at',       label: 'Started',      num: false },
  { key: 'completed_at',     label: 'Completed',    num: false },
  { key: 'best_publish_p99',  label: 'Best Pub P99',   num: true  },
  { key: 'best_publish_p999', label: 'Best Pub P99.9', num: true  },
  { key: 'best_e2e_p99',      label: 'Best E2E P99',   num: true  },
  { key: 'best_e2e_p999',     label: 'Best E2E P99.9', num: true  },
]

function sortedSweeps(sweeps, col, dir) {
  if (!col || !dir) return sweeps
  return [...sweeps].sort((a, b) => {
    const av = a[col] ?? null
    const bv = b[col] ?? null
    if (av == null && bv == null) return 0
    if (av == null) return 1
    if (bv == null) return -1
    const cmp = typeof av === 'number' ? av - bv : String(av).localeCompare(String(bv))
    return dir === 'asc' ? cmp : -cmp
  })
}

function SortIcon({ active, dir }) {
  if (!active) return <span style={{ opacity: 0.3, marginLeft: 4 }}>⇅</span>
  return <span style={{ marginLeft: 4 }}>{dir === 'asc' ? '▲' : '▼'}</span>
}

export default function SweepsPage() {
  const navigate = useNavigate()
  const [sweeps, setSweeps] = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)
  const [sortCol, setSortCol] = useState('started_at')
  const [sortDir, setSortDir] = useState('desc')

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

  function handleSort(key) {
    if (sortCol === key) {
      if (sortDir === 'asc') setSortDir('desc')
      else if (sortDir === 'desc') { setSortCol(null); setSortDir(null) }
    } else {
      setSortCol(key)
      setSortDir('asc')
    }
  }

  const displayed = sortedSweeps(sweeps, sortCol, sortDir)

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
                {COLS.map(col => (
                  <th
                    key={col.key}
                    className={col.num ? 'num' : ''}
                    style={{ cursor: 'pointer', userSelect: 'none', whiteSpace: 'nowrap' }}
                    onClick={() => handleSort(col.key)}
                  >
                    {col.label}
                    <SortIcon active={sortCol === col.key} dir={sortDir} />
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {displayed.map(s => (
                <tr
                  key={s.id}
                  style={{ cursor: 'pointer' }}
                  onClick={() => navigate(`/sweeps/${s.id}`)}
                >
                  <td>#{s.id}</td>
                  <td>{s.name}</td>
                  <td><SweepStatusBadge status={s.status} /></td>
                  <td className="text-small text-muted">
                    {s.started_at ? new Date(s.started_at).toLocaleString() : '—'}
                  </td>
                  <td className="text-small text-muted">
                    {s.completed_at ? new Date(s.completed_at).toLocaleString() : '—'}
                  </td>
                  <td className="num">{fmt(s.best_publish_p99)}</td>
                  <td className="num">{fmt(s.best_publish_p999)}</td>
                  <td className="num">{fmt(s.best_e2e_p99)}</td>
                  <td className="num">{fmt(s.best_e2e_p999)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}
