import { useEffect, useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { listRuns } from '../api.js'

const BADGE_LABELS = { completed: '✓ completed', failed: '✗ failed' }
function StatusBadge({ status }) {
  return <span className={`badge badge-${status}`}>{BADGE_LABELS[status] ?? status}</span>
}

function fmt(n, unit = '') {
  if (n == null) return '—'
  return n.toLocaleString(undefined, { maximumFractionDigits: 1 }) + (unit ? ' ' + unit : '')
}

const COLS = [
  { key: 'id',                     label: 'ID',               num: false },
  { key: 'name',                   label: 'Name',             num: false },
  { key: 'sweep',                  label: 'Sweep',            num: false },
  { key: 'status',                 label: 'Status',           num: false },
  { key: 'started_at',             label: 'Started',          num: false },
  { key: 'publish_rate_avg',       label: 'Pub Rate (msg/s)', num: true  },
  { key: 'publish_latency_p99',    label: 'Pub P99 (ms)',     num: true  },
  { key: 'publish_latency_p999',   label: 'Pub P99.9 (ms)',   num: true  },
  { key: 'end_to_end_latency_p99', label: 'E2E P99 (ms)',     num: true  },
  { key: 'end_to_end_latency_p999',label: 'E2E P99.9 (ms)',   num: true  },
  { key: 'consume_rate_avg',       label: 'Consume Rate',     num: true  },
]

function sortValue(run, key) {
  if (key === 'sweep') return run.sweep_name ?? (run.sweep_id != null ? String(run.sweep_id) : null)
  return run[key] ?? null
}

function sortedRuns(runs, col, dir) {
  if (!col || !dir) return runs
  return [...runs].sort((a, b) => {
    const av = sortValue(a, col)
    const bv = sortValue(b, col)
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

export default function RunsPage() {
  const navigate = useNavigate()
  const [runs, setRuns] = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)
  const [sortCol, setSortCol] = useState('started_at')
  const [sortDir, setSortDir] = useState('desc')

  useEffect(() => {
    listRuns()
      .then(data => { setRuns(data); setError(null) })
      .catch(e => setError(e.message))
      .finally(() => setLoading(false))
  }, [])

  function handleSort(key) {
    if (sortCol === key) {
      if (sortDir === 'asc') setSortDir('desc')
      else if (sortDir === 'desc') { setSortCol(null); setSortDir(null) }
    } else {
      setSortCol(key)
      setSortDir('asc')
    }
  }

  const displayed = sortedRuns(runs, sortCol, sortDir)

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
              {displayed.map(run => (
                <tr
                  key={run.id}
                  style={{ cursor: 'pointer' }}
                  onClick={() => navigate(`/runs/${run.id}`)}
                >
                  <td>#{run.id}</td>
                  <td>{run.name || <span className="text-muted">—</span>}</td>
                  <td>
                    {run.sweep_id != null ? (
                      <Link
                        to={`/sweeps/${run.sweep_id}`}
                        style={{ color: 'var(--accent)' }}
                        onClick={e => e.stopPropagation()}
                      >
                        {run.sweep_name || `#${run.sweep_id}`}
                      </Link>
                    ) : (
                      <span className="text-muted">—</span>
                    )}
                  </td>
                  <td style={{ whiteSpace: 'nowrap' }}><StatusBadge status={run.status} /></td>
                  <td className="text-small text-muted" style={{ whiteSpace: 'nowrap' }}>
                    {run.started_at ? new Date(run.started_at.endsWith('Z') ? run.started_at : run.started_at + 'Z').toLocaleString() : '—'}
                  </td>
                  <td className="num">{fmt(run.publish_rate_avg)}</td>
                  <td className="num">{fmt(run.publish_latency_p99)}</td>
                  <td className="num">{fmt(run.publish_latency_p999)}</td>
                  <td className="num">{fmt(run.end_to_end_latency_p99)}</td>
                  <td className="num">{fmt(run.end_to_end_latency_p999)}</td>
                  <td className="num">{fmt(run.consume_rate_avg)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}
