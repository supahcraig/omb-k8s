import { useEffect, useRef, useState } from 'react'
import { useParams, Link } from 'react-router-dom'
import { getRun, cancelRun, getPrometheusSamples } from '../api.js'
import RunCharts from '../components/RunCharts.jsx'
import { parseLiveMetric, parseE2ELatency } from '../lib/ombLogParser.js'
import { parseWorkloadYaml } from '../components/WorkloadForm.jsx'

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


export default function RunDetailPage() {
  const { id } = useParams()
  const [run, setRun] = useState(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)
  const [logs, setLogs] = useState([])
  const [logDone, setLogDone] = useState(false)
  const [promSamples, setPromSamples] = useState([])
  const [livePoints, setLivePoints] = useState([])
  const [warmupStartedAt, setWarmupStartedAt] = useState(null)
  const [benchmarkStartedAt, setBenchmarkStartedAt] = useState(null)
  const wsRef = useRef(null)
  const logEndRef = useRef(null)
  const liveMatchedRef = useRef(false)

  async function loadRun() {
    try {
      const data = await getRun(id)
      setRun(data)
      setError(null)
      if (data.status === 'completed') {
        getPrometheusSamples(id).then(setPromSamples).catch(() => {})
      }
      // Seed progress bar position from DB timestamp when navigating to a run
      // mid-flight so the bar isn't stuck at 0. The precise log-line timestamps
      // will overwrite this if they arrive via WebSocket.
      if (data.status === 'running' && data.started_at) {
        const t = new Date(data.started_at).getTime()
        setWarmupStartedAt(prev => prev ?? t)
      }
    } catch (e) {
      setError(e.message)
    } finally {
      setLoading(false)
    }
  }

  // After the WebSocket signals completion the backend _finish_run task may
  // still be writing to the DB (it polls every 2 s).  Poll until the status
  // leaves "running" so the UI reflects the final result without a manual
  // refresh.
  async function pollUntilFinished() {
    for (let i = 0; i < 20; i++) {
      await new Promise(r => setTimeout(r, 500))
      try {
        const data = await getRun(id)
        setRun(data)
        if (data.status !== 'running') {
          if (data.status === 'completed') {
            getPrometheusSamples(id).then(setPromSamples).catch(() => {})
          }
          return
        }
      } catch { return }
    }
  }

  useEffect(() => {
    // Reset live state when navigating to a new run
    setLivePoints([])
    setWarmupStartedAt(null)
    setBenchmarkStartedAt(null)
    liveMatchedRef.current = false
    setLogs([])
    setLogDone(false)

    loadRun()
    // WebSocket log streaming
    const proto = window.location.protocol === 'https:' ? 'wss' : 'ws'
    const wsUrl = `${proto}://${window.location.host}/ws/runs/${id}`
    const ws = new WebSocket(wsUrl)
    wsRef.current = ws

    const warnTimer = setTimeout(() => {
      if (!liveMatchedRef.current) {
        console.warn('[RunCharts] No OMB stat lines matched after 10s. Check log format.')
      }
    }, 10000)

    ws.onmessage = (evt) => {
      try {
        const msg = JSON.parse(evt.data)
        if (msg.type === 'done') {
          setLogDone(true)
          pollUntilFinished()
          return
        }
      } catch { /* not JSON — it's a log line */ }
      const line = evt.data
      setLogs(prev => [...prev, line])
      if (line.includes('Starting warm-up traffic'))  setWarmupStartedAt(Date.now())
      if (line.includes('Starting benchmark traffic')) setBenchmarkStartedAt(Date.now())
      setLivePoints(prev => {
        const p = parseLiveMetric(line, prev.length)
        if (!p) return prev
        liveMatchedRef.current = true
        return [...prev, p]
      })
      // Patch e2e latency onto the most recent point when E2E line arrives
      const e2eObj = parseE2ELatency(line)
      if (e2eObj !== null) {
        setLivePoints(prev => {
          if (prev.length === 0) return prev
          const last = { ...prev[prev.length - 1], ...e2eObj }
          return [...prev.slice(0, -1), last]
        })
      }
    }

    ws.onerror = () => setLogDone(true)
    ws.onclose = () => {
      setLogDone(true)
      pollUntilFinished()
    }

    return () => {
      clearTimeout(warnTimer)
      ws.close()
    }
  }, [id])

  // Fetch Prometheus samples immediately and then every 5s while run is live
  useEffect(() => {
    if (run?.status !== 'running') return
    getPrometheusSamples(id).then(setPromSamples).catch(() => {})
    const interval = setInterval(() => {
      getPrometheusSamples(id).then(setPromSamples).catch(() => {})
    }, 5000)
    return () => clearInterval(interval)
  }, [id, run?.status])

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
  const workloadParams = run?.workload_config ? parseWorkloadYaml(run.workload_config) : {}
  const messageSize = workloadParams?.values?.messageSize ?? 1024
  const warmupSamples = (workloadParams?.values?.warmupDurationMinutes ?? 1) * 60
  const totalSamples  = ((workloadParams?.values?.warmupDurationMinutes ?? 1) + (workloadParams?.values?.testDurationMinutes ?? 5)) * 60

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

      {/* Charts — live during run, post-run from stored metrics + Prometheus */}
      <RunCharts
        livePoints={livePoints}
        metricsOut={run?.metrics ?? null}
        promSamples={promSamples}
        isLive={run?.status === 'running'}
        messageSize={messageSize}
        warmupSamples={warmupSamples}
        totalSamples={totalSamples}
        warmupStartedAt={warmupStartedAt}
        benchmarkStartedAt={benchmarkStartedAt}
      />

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
