import { useEffect, useRef, useState } from 'react'
import { useParams, Link } from 'react-router-dom'
import { getRun, cancelRun, getPrometheusSamples } from '../api.js'

function StatusBadge({ status }) {
  return <span className={`badge badge-${status}`}>{status}</span>
}

function fmt(n, digits = 1) {
  if (n == null) return '—'
  return n.toLocaleString(undefined, { maximumFractionDigits: digits })
}

function MetricCard({ label, value, unit }) {
  return (
    <div className="metric-card">
      <div className="metric-label">{label}</div>
      <div className="metric-value">{value}</div>
      {unit && <div className="metric-unit">{unit}</div>}
    </div>
  )
}

function LatencyTable({ metrics }) {
  const percentiles = ['p50', 'p75', 'p95', 'p99', 'p999', 'p9999', 'max']
  return (
    <div className="card mt-20">
      <div className="card-header"><h3>Latency Percentiles (ms)</h3></div>
      <table className="data-table">
        <thead>
          <tr>
            <th>Metric</th>
            {percentiles.map(p => <th key={p} className="num">{p.toUpperCase()}</th>)}
            <th className="num">Avg</th>
          </tr>
        </thead>
        <tbody>
          <tr>
            <td>Publish Latency</td>
            {percentiles.map(p => (
              <td key={p} className="num">{fmt(metrics[`publish_latency_${p}`])}</td>
            ))}
            <td className="num">{fmt(metrics.publish_latency_avg)}</td>
          </tr>
          <tr>
            <td>End-to-End Latency</td>
            {percentiles.map(p => (
              <td key={p} className="num">{fmt(metrics[`end_to_end_latency_${p}`])}</td>
            ))}
            <td className="num">{fmt(metrics.end_to_end_latency_avg)}</td>
          </tr>
        </tbody>
      </table>
    </div>
  )
}

// Simple SVG line chart
function LineChart({ data, xKey, yKey, label, color = '#e63946' }) {
  if (!data || data.length < 2) return null

  const W = 700, H = 200
  const PAD = { top: 20, right: 20, bottom: 30, left: 60 }
  const w = W - PAD.left - PAD.right
  const h = H - PAD.top - PAD.bottom

  const xs = data.map(d => d[xKey])
  const ys = data.map(d => d[yKey]).filter(v => v != null)
  if (!ys.length) return null

  const xMin = Math.min(...xs), xMax = Math.max(...xs)
  const yMin = 0, yMax = Math.max(...ys) * 1.1

  const scX = v => (xMax === xMin ? w / 2 : ((v - xMin) / (xMax - xMin)) * w)
  const scY = v => (yMax === 0 ? h : h - ((v - yMin) / (yMax - yMin)) * h)

  const points = data
    .filter(d => d[yKey] != null)
    .map(d => `${scX(d[xKey]).toFixed(1)},${scY(d[yKey]).toFixed(1)}`)
    .join(' ')

  const yLabels = [0, 0.25, 0.5, 0.75, 1].map(t => ({
    v: yMin + t * (yMax - yMin),
    y: scY(yMin + t * (yMax - yMin)),
  }))

  function fmtY(v) {
    if (yMax > 1e6) return `${(v / 1e6).toFixed(1)}M`
    if (yMax > 1e3) return `${(v / 1e3).toFixed(0)}K`
    return v.toFixed(0)
  }

  return (
    <div className="chart-container mt-20">
      <div className="metric-label" style={{ marginBottom: 8 }}>{label}</div>
      <svg width={W} height={H} viewBox={`0 0 ${W} ${H}`} style={{ maxWidth: '100%' }}>
        <g transform={`translate(${PAD.left},${PAD.top})`}>
          {yLabels.map(({ v, y }) => (
            <g key={v}>
              <line x1={0} y1={y} x2={w} y2={y} stroke="#e8e8e8" strokeWidth="1" />
              <text x={-4} y={y + 4} textAnchor="end" fontSize="10" fill="#888">{fmtY(v)}</text>
            </g>
          ))}
          <polyline
            points={points}
            fill="none"
            stroke={color}
            strokeWidth="2"
            strokeLinejoin="round"
          />
          <text x={w / 2} y={h + 22} textAnchor="middle" fontSize="10" fill="#888">Time (s)</text>
        </g>
      </svg>
    </div>
  )
}

export default function RunDetailPage() {
  const { id } = useParams()
  const [run, setRun] = useState(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)
  const [logs, setLogs] = useState([])
  const [logDone, setLogDone] = useState(false)
  const [promSamples, setPromSamples] = useState([])
  const wsRef = useRef(null)
  const logEndRef = useRef(null)

  async function loadRun() {
    try {
      const data = await getRun(id)
      setRun(data)
      setError(null)
      if (data.status === 'completed') {
        // Try to load prometheus samples
        getPrometheusSamples(id).then(setPromSamples).catch(() => {})
      }
    } catch (e) {
      setError(e.message)
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    loadRun()
    // WebSocket log streaming
    const proto = window.location.protocol === 'https:' ? 'wss' : 'ws'
    const wsUrl = `${proto}://${window.location.host}/ws/runs/${id}`
    const ws = new WebSocket(wsUrl)
    wsRef.current = ws

    ws.onmessage = (evt) => {
      try {
        const msg = JSON.parse(evt.data)
        if (msg.type === 'done') {
          setLogDone(true)
          loadRun()
          return
        }
      } catch { /* not JSON — it's a log line */ }
      setLogs(prev => [...prev, evt.data])
    }

    ws.onerror = () => setLogDone(true)
    ws.onclose = () => {
      setLogDone(true)
      loadRun()
    }

    return () => ws.close()
  }, [id])

  // Auto-scroll log
  useEffect(() => {
    logEndRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [logs])

  async function handleCancel() {
    if (!confirm('Cancel this run?')) return
    try {
      await cancelRun(id)
      loadRun()
    } catch (e) {
      alert(e.message)
    }
  }

  if (loading) return <div className="text-muted mt-20">Loading run…</div>
  if (error) return <div className="alert alert-error">{error}</div>
  if (!run) return null

  const m = run.metrics

  return (
    <div>
      <div className="page-header">
        <div>
          <Link to="/" className="btn btn-secondary btn-sm">← Back to Runs</Link>
          <h1 className="page-title mt-8">
            Run #{run.id} {run.name && `— ${run.name}`}
          </h1>
          <div className="flex items-center gap-8 mt-4">
            <StatusBadge status={run.status} />
            {run.started_at && (
              <span className="text-muted text-small">
                Started {new Date(run.started_at).toLocaleString()}
              </span>
            )}
            {run.completed_at && (
              <span className="text-muted text-small">
                Completed {new Date(run.completed_at).toLocaleString()}
              </span>
            )}
          </div>
        </div>
        {(run.status === 'running') && (
          <button className="btn btn-danger" onClick={handleCancel}>Cancel Run</button>
        )}
      </div>

      {/* Summary metrics */}
      {m && (
        <>
          <div className="metrics-grid">
            <MetricCard label="Publish Rate" value={fmt(m.publish_rate_avg)} unit="msg/s" />
            <MetricCard label="Consume Rate" value={fmt(m.consume_rate_avg)} unit="msg/s" />
            <MetricCard label="Pub Latency Avg" value={fmt(m.publish_latency_avg)} unit="ms" />
            <MetricCard label="Pub Latency P99" value={fmt(m.publish_latency_p99)} unit="ms" />
            <MetricCard label="E2E Latency Avg" value={fmt(m.end_to_end_latency_avg)} unit="ms" />
            <MetricCard label="E2E Latency P99" value={fmt(m.end_to_end_latency_p99)} unit="ms" />
          </div>
          <LatencyTable metrics={m} />
        </>
      )}

      {/* Prometheus throughput chart */}
      {promSamples.length > 0 && (
        <LineChart
          data={promSamples}
          xKey="t"
          yKey="bytes_in_per_sec"
          label="Bytes In/sec (Prometheus)"
        />
      )}

      {/* Log output */}
      <div className="card mt-20">
        <div className="card-header">
          <h3>Run Log</h3>
          {!logDone && run.status === 'running' && (
            <span className="text-small text-muted flex items-center gap-8">
              <span className="spinner spinner-dark" /> Live streaming…
            </span>
          )}
        </div>
        <div className="card-body" style={{ padding: 0 }}>
          <div className="log-viewer">
            {logs.length === 0 && !logDone ? 'Waiting for log output…' : logs.join('\n')}
            <div ref={logEndRef} />
          </div>
        </div>
      </div>

      {/* Config details */}
      <details className="card mt-20" style={{ padding: 0 }}>
        <summary style={{ padding: '12px 20px', cursor: 'pointer', fontWeight: 600 }}>
          Configuration YAML
        </summary>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 0, padding: '0 20px 20px' }}>
          <div>
            <div className="text-small text-muted mb-4">Driver</div>
            <pre className="log-viewer" style={{ maxHeight: 300, fontSize: 11 }}>{run.driver_config}</pre>
          </div>
          <div>
            <div className="text-small text-muted mb-4">Workload</div>
            <pre className="log-viewer" style={{ maxHeight: 300, fontSize: 11 }}>{run.workload_config}</pre>
          </div>
        </div>
      </details>
    </div>
  )
}
