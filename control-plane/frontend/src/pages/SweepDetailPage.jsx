import { useEffect, useMemo, useRef, useState } from 'react'
import { useParams, Link, useNavigate } from 'react-router-dom'
import { getSweep, getSweepRuns, cancelSweep, getSweepVisualizationData } from '../api.js'
import useGrafanaUrl from '../hooks/useGrafanaUrl.js'
import { buildSweepGrafanaUrl } from '../lib/grafanaUtils.js'
import { parseWorkloadYaml } from '../components/WorkloadForm.jsx'
import SweepPercentileCurves from '../components/SweepPercentileCurves.jsx'
import SweepHeatmap from '../components/SweepHeatmap.jsx'

const RUN_COLORS = [
  '#6366f1', '#e63946', '#6ee7b7', '#f59e0b', '#818cf8',
  '#f97316', '#34d399', '#fb7185', '#38bdf8', '#a78bfa',
]

const TH_STICKY = {
  position: 'sticky', top: 0, zIndex: 1,
  background: '#1e2538',
  boxShadow: '0 1px 0 #2a3045',
}

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

function SortTh({ col, label, sortCol, sortDir, onSort, className, style }) {
  const active = sortCol === col
  return (
    <th
      className={className}
      onClick={() => onSort(col)}
      style={{ cursor: 'pointer', userSelect: 'none', whiteSpace: 'nowrap', ...style }}
    >
      {label}{active ? (sortDir === 'asc' ? ' ↑' : ' ↓') : ''}
    </th>
  )
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
  const [visData, setVisData] = useState(null)
  const [sortCol, setSortCol] = useState(null)
  const [sortDir, setSortDir] = useState('asc')
  const [selectedRunIds, setSelectedRunIds] = useState(new Set())
  const sweepRef = useRef(null)
  const autoSelectedRef = useRef(false)
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

  async function loadVisData() {
    try {
      const data = await getSweepVisualizationData(id)
      setVisData(data)
    } catch {
      // non-critical
    }
  }

  useEffect(() => {
    load()
    loadVisData()
    const iv = setInterval(() => {
      const isDone = ['completed', 'cancelled', 'failed'].includes(sweepRef.current?.status)
      if (!isDone) load()
      loadVisData()
    }, 3000)
    const tick = setInterval(() => setTick(t => t + 1), 1000)
    return () => { clearInterval(iv); clearInterval(tick) }
  }, [id])

  // Auto-select best pub P99 + best E2E P99 on first visData load that has results.
  // Once the user touches any checkbox, autoSelectedRef prevents future overrides.
  useEffect(() => {
    if (!visData || autoSelectedRef.current) return
    const withPub = visData.runs.filter(r => r.publish_p99 != null)
    const withE2e = visData.runs.filter(r => r.e2e_p99 != null)
    if (withPub.length === 0 && withE2e.length === 0) return
    autoSelectedRef.current = true
    const bestPub = withPub.reduce((a, b) => a.publish_p99 < b.publish_p99 ? a : b)
    const bestE2e = withE2e.reduce((a, b) => a.e2e_p99   < b.e2e_p99   ? a : b)
    setSelectedRunIds(new Set([bestPub.run_id, bestE2e.run_id]))
  }, [visData])

  // Map run_id → {colorIndex, publish_p99, e2e_p99, ...} from visData
  const visDataByRunId = useMemo(() => {
    if (!visData) return {}
    const map = {}
    visData.runs.forEach((r, i) => { map[r.run_id] = { ...r, colorIndex: i } })
    return map
  }, [visData])

  // Map run_id → previous run in execution order (for cooldown display)
  const prevRunByRunId = useMemo(() => {
    const map = {}
    runs.forEach((r, i) => { if (i > 0) map[r.id] = runs[i - 1] })
    return map
  }, [runs])

  const sortedRuns = useMemo(() => {
    if (!sortCol) return runs
    return [...runs].sort((a, b) => {
      const ma = a.metrics
      const mb = b.metrics
      const pa = parseParams(a.sweep_params)
      const pb = parseParams(b.sweep_params)
      const vda = visDataByRunId[a.id]
      const vdb = visDataByRunId[b.id]

      let av, bv
      switch (sortCol) {
        case 'id':       av = a.id;     bv = b.id;     break
        case 'status':   av = a.status; bv = b.status; break
        case 'pub_rate': av = ma?.publish_rate_avg ?? -Infinity; bv = mb?.publish_rate_avg ?? -Infinity; break
        case 'pub_mb':   av = ma?.publish_rate_avg ?? -Infinity; bv = mb?.publish_rate_avg ?? -Infinity; break
        case 'con_rate': av = ma?.consume_rate_avg ?? -Infinity; bv = mb?.consume_rate_avg ?? -Infinity; break
        case 'con_mb':   av = ma?.consume_rate_avg ?? -Infinity; bv = mb?.consume_rate_avg ?? -Infinity; break
        case 'pub_p99':  av = ma?.publish_latency_p99  ?? Infinity; bv = mb?.publish_latency_p99  ?? Infinity; break
        case 'pub_p999': av = ma?.publish_latency_p999 ?? Infinity; bv = mb?.publish_latency_p999 ?? Infinity; break
        case 'e2e_p99':  av = ma?.end_to_end_latency_p99  ?? Infinity; bv = mb?.end_to_end_latency_p99  ?? Infinity; break
        case 'e2e_p999': av = ma?.end_to_end_latency_p999 ?? Infinity; bv = mb?.end_to_end_latency_p999 ?? Infinity; break
        default:         av = pa[sortCol] ?? ''; bv = pb[sortCol] ?? ''; break
      }
      if (av < bv) return sortDir === 'asc' ? -1 : 1
      if (av > bv) return sortDir === 'asc' ? 1 : -1
      return 0
    })
  }, [runs, sortCol, sortDir, visDataByRunId])

  function handleSort(col) {
    setSortDir(prev => sortCol === col ? (prev === 'asc' ? 'desc' : 'asc') : 'asc')
    setSortCol(col)
  }

  function toggleRun(runId) {
    autoSelectedRef.current = true  // user is in manual control now
    setSelectedRunIds(prev => {
      const next = new Set(prev)
      if (next.has(runId)) next.delete(runId)
      else next.add(runId)
      return next
    })
  }

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

  const messageSize = (() => {
    const cfg = runs[0]?.workload_config
    if (!cfg) return 1024
    return parseWorkloadYaml(cfg)?.values?.messageSize ?? 1024
  })()

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
          <div style={{ overflowY: 'auto', maxHeight: 520 }}>
            <table className="data-table">
              <thead>
                <tr>
                  <th style={{ ...TH_STICKY, width: 44, padding: '0 8px' }} />
                  <SortTh col="id"       label="Run"            sortCol={sortCol} sortDir={sortDir} onSort={handleSort} style={TH_STICKY} />
                  <SortTh col="status"   label="Status"         sortCol={sortCol} sortDir={sortDir} onSort={handleSort} style={TH_STICKY} />
                  {paramKeys.map(k => (
                    <SortTh key={k} col={k} label={k}           sortCol={sortCol} sortDir={sortDir} onSort={handleSort} style={{ ...TH_STICKY, maxWidth: 100 }} />
                  ))}
                  <SortTh col="pub_rate"  label="Pub (msg/s)"    className="num" sortCol={sortCol} sortDir={sortDir} onSort={handleSort} style={TH_STICKY} />
                  <SortTh col="pub_mb"    label="Pub (MB/s)"     className="num" sortCol={sortCol} sortDir={sortDir} onSort={handleSort} style={TH_STICKY} />
                  <SortTh col="con_rate"  label="Con (msg/s)"    className="num" sortCol={sortCol} sortDir={sortDir} onSort={handleSort} style={TH_STICKY} />
                  <SortTh col="con_mb"    label="Con (MB/s)"     className="num" sortCol={sortCol} sortDir={sortDir} onSort={handleSort} style={TH_STICKY} />
                  <SortTh col="pub_p99"   label="Pub P99 (ms)"   className="num" sortCol={sortCol} sortDir={sortDir} onSort={handleSort} style={TH_STICKY} />
                  <SortTh col="pub_p999"  label="Pub P99.9 (ms)" className="num" sortCol={sortCol} sortDir={sortDir} onSort={handleSort} style={TH_STICKY} />
                  <SortTh col="e2e_p99"   label="E2E P99 (ms)"   className="num" sortCol={sortCol} sortDir={sortDir} onSort={handleSort} style={TH_STICKY} />
                  <SortTh col="e2e_p999"  label="E2E P99.9 (ms)" className="num" sortCol={sortCol} sortDir={sortDir} onSort={handleSort} style={TH_STICKY} />
                  <th style={TH_STICKY} />
                </tr>
              </thead>
              <tbody>
                {sortedRuns.map(run => {
                  const params  = parseParams(run.sweep_params)
                  const m       = run.metrics
                  const vd      = visDataByRunId[run.id]
                  const color   = vd ? RUN_COLORS[vd.colorIndex % RUN_COLORS.length] : null
                  const pubMB   = m?.publish_rate_avg != null ? m.publish_rate_avg * messageSize / 1_048_576 : null
                  const consMB  = m?.consume_rate_avg != null ? m.consume_rate_avg * messageSize / 1_048_576 : null
                  const checked = selectedRunIds.has(run.id)
                  return (
                    <tr
                      key={run.id}
                      style={{ cursor: 'pointer' }}
                      onClick={() => navigate(`/runs/${run.id}`)}
                    >
                      <td onClick={e => e.stopPropagation()} style={{ width: 44, padding: '0 8px' }}>
                        <div style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
                          <input
                            type="checkbox"
                            checked={checked}
                            onChange={() => toggleRun(run.id)}
                            style={color ? { accentColor: color } : {}}
                          />
                          {color && (
                            <span style={{
                              width: 10, height: 10, borderRadius: 2,
                              background: color, flexShrink: 0, display: 'inline-block',
                            }} />
                          )}
                        </div>
                      </td>
                      <td>#{run.id}</td>
                      <td>
                        <RunStatusPill
                          run={run}
                          prevRun={prevRunByRunId[run.id]}
                          cooldownSeconds={sweep.cooldown_seconds ?? 0}
                        />
                      </td>
                      {paramKeys.map(k => (
                        <td key={k} style={{ maxWidth: 100, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                          {params[k] ?? '—'}
                        </td>
                      ))}
                      <td className="num">{fmt(m?.publish_rate_avg)}</td>
                      <td className="num">{fmt(pubMB, 2)}</td>
                      <td className="num">{fmt(m?.consume_rate_avg)}</td>
                      <td className="num">{fmt(consMB, 2)}</td>
                      <td className="num">{fmt(m?.publish_latency_p99,  2)}</td>
                      <td className="num">{fmt(m?.publish_latency_p999, 2)}</td>
                      <td className="num">{fmt(m?.end_to_end_latency_p99,  2)}</td>
                      <td className="num">{fmt(m?.end_to_end_latency_p999, 2)}</td>
                      <td onClick={e => e.stopPropagation()}>
                        <Link to={`/runs/${run.id}`} className="btn btn-secondary btn-sm">Details</Link>
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {visData && visData.runs.length > 0 && (
        <>
          <div className="card" style={{ marginTop: 24 }}>
            <div className="card-header">
              <h3>Latency percentile curves</h3>
            </div>
            <div style={{ padding: '12px 0' }}>
              <SweepPercentileCurves visData={visData} selectedRunIds={selectedRunIds} />
            </div>
          </div>

          <div className="card" style={{ marginTop: 24 }}>
            <div className="card-header">
              <h3>Latency heatmaps</h3>
            </div>
            <div style={{ padding: '12px 0' }}>
              <SweepHeatmap visData={visData} />
            </div>
          </div>
        </>
      )}
    </div>
  )
}
