import { useEffect, useRef, useState } from 'react'
import { useParams, Link, useNavigate } from 'react-router-dom'
import { getSweep, getSweepRuns, cancelSweep } from '../api.js'
import useGrafanaUrl from '../hooks/useGrafanaUrl.js'
import { buildSweepGrafanaUrl } from '../lib/grafanaUtils.js'

function StatusBadge({ status }) {
  const cls = {
    running: 'badge-running', completed: 'badge-completed',
    failed: 'badge-failed', pending: 'badge-pending', cancelled: 'badge-cancelled',
  }[status] || 'badge-pending'
  return <span className={`badge ${cls}`}>{status}</span>
}

function RunStatusPill({ run, prevRun, cooldownSeconds }) {
  const isCooling = (() => {
    if (run.status !== 'pending' || !prevRun || prevRun.status !== 'completed' || !prevRun.completed_at) return false
    const ts = prevRun.completed_at.endsWith('Z') ? prevRun.completed_at : prevRun.completed_at + 'Z'
    return Date.now() < new Date(ts).getTime() + cooldownSeconds * 1000
  })()
  const pillStatus = isCooling ? 'cooling' : run.status
  const label = run.status.charAt(0).toUpperCase() + run.status.slice(1)
  return <span className={`sweep-run-pill sweep-run-pill-${pillStatus}`}>{label}</span>
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
  const navigate = useNavigate()
  const [sweep, setSweep] = useState(null)
  const [runs, setRuns] = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)
  const [, setTick] = useState(0)
  const sweepRef = useRef(null)
  const grafanaUrl = useGrafanaUrl()

  async function load() {
    try {
      const [sw, rs] = await Promise.all([getSweep(id), getSweepRuns(id)])
      setSweep(sw)
      sweepRef.current = sw
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
    const iv = setInterval(() => {
      if (!['completed', 'cancelled', 'failed'].includes(sweepRef.current?.status)) load()
    }, 3000)
    const tick = setInterval(() => setTick(t => t + 1), 1000)
    return () => { clearInterval(iv); clearInterval(tick) }
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

  const paramKeys = Array.from(new Set(
    runs.flatMap(r => Object.keys(parseParams(r.sweep_params)))
  ))

  const sweepGrafanaUrl = grafanaUrl ? buildSweepGrafanaUrl(grafanaUrl, runs) : null

  return (
    <div>
      <div className="page-header">
        <div>
          <Link to="/sweeps" className="btn btn-secondary btn-sm">← Back to Sweeps</Link>
          <div className="flex items-center gap-8 mt-8">
            <h1 className="page-title">{sweep.name}</h1>
            <span style={{
              fontSize: 13, fontWeight: 600, color: 'var(--color-text-muted)',
              background: 'rgba(255,255,255,0.06)', border: '1px solid var(--color-border)',
              borderRadius: 4, padding: '2px 10px',
            }}>
              Sweep #{id}
            </span>
          </div>
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
        <div className="card-header" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <h3>Run Comparison — {runs.length} run{runs.length !== 1 ? 's' : ''}</h3>
          {sweepGrafanaUrl && (
            <a
              href={sweepGrafanaUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="badge"
              style={{ textDecoration: 'none', background: 'rgba(249,115,22,0.15)', color: '#f97316', border: '1px solid rgba(249,115,22,0.3)' }}
            >
              📊 Full sweep in Grafana ↗
            </a>
          )}
        </div>
        {runs.length === 0 ? (
          <div className="empty-state"><p>No runs yet.</p></div>
        ) : (
          <table className="data-table">
            <thead>
              {paramKeys.length > 0 && (
                <tr>
                  <th colSpan={2} />
                  <th
                    colSpan={paramKeys.length}
                    style={{
                      textAlign: 'center', fontSize: 10, fontWeight: 700,
                      textTransform: 'uppercase', letterSpacing: '0.08em',
                      color: 'var(--color-text-muted)',
                      borderBottom: '1px solid var(--color-border)',
                      paddingBottom: 4,
                    }}
                  >
                    Sweep Parameters
                  </th>
                  <th colSpan={5} />
                </tr>
              )}
              <tr>
                <th>Run</th>
                <th>Status</th>
                {paramKeys.map(k => (
                  <th key={k} style={{ maxWidth: 90, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{k}</th>
                ))}
                <th className="num">Pub Rate (msg/s)</th>
                <th className="num">Pub P99 (ms)</th>
                <th className="num">E2E P99 (ms)</th>
                <th className="num">Consume Rate</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {runs.map((run, i) => {
                const params = parseParams(run.sweep_params)
                const m = run.metrics
                return (
                  <tr
                    key={run.id}
                    style={{ cursor: 'pointer' }}
                    onClick={() => navigate(`/runs/${run.id}`)}
                  >
                    <td>#{run.id}</td>
                    <td><RunStatusPill run={run} prevRun={runs[i - 1]} cooldownSeconds={sweep.cooldown_seconds ?? 0} /></td>
                    {paramKeys.map(k => (
                      <td key={k} style={{ maxWidth: 90, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{params[k] ?? '—'}</td>
                    ))}
                    <td className="num">{fmt(m?.publish_rate_avg)}</td>
                    <td className="num">{fmt(m?.publish_latency_p99)}</td>
                    <td className="num">{fmt(m?.end_to_end_latency_p99)}</td>
                    <td className="num">{fmt(m?.consume_rate_avg)}</td>
                    <td onClick={e => e.stopPropagation()}>
                      <Link to={`/runs/${run.id}`} className="btn btn-secondary btn-sm">Details</Link>
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
