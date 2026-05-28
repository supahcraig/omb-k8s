import { useEffect, useRef, useState } from 'react'
import { useParams, Link, useNavigate } from 'react-router-dom'
import { getRun, cancelRun, getPrometheusSamples, getSweepRuns, getSweep, getWorkerResources } from '../api.js'
import RunCharts from '../components/RunCharts.jsx'
import { parseLiveMetric, parseE2ELatency } from '../lib/ombLogParser.js'
import { parseWorkloadYaml } from '../components/WorkloadForm.jsx'

const STATUS_LABELS = {
  initializing: '⏳ initializing',
  warmup:       '🌡️ warming up',
  running:      '⚡ running',
  cooldown:     '🧊 cooldown',
  queued:       '⏸️ queued',
  completed:    '✓ completed',
  failed:       '✗ failed',
  pending:      'pending',
  cancelled:    'cancelled',
}

function StatusBadge({ status }) {
  return <span className={`badge badge-${status}`}>{STATUS_LABELS[status] ?? status}</span>
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
  const navigate = useNavigate()
  const [run, setRun] = useState(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)
  const [logs, setLogs] = useState([])
  const [logDone, setLogDone] = useState(false)
  const [promSamples, setPromSamples] = useState([])
  const [livePoints, setLivePoints] = useState([])
  const [warmupStartedAt, setWarmupStartedAt] = useState(null)
  const [benchmarkStartedAt, setBenchmarkStartedAt] = useState(null)
  const [sweepRuns, setSweepRuns] = useState(null)
  const [sweep, setSweep] = useState(null)
  const [cooldownRemaining, setCooldownRemaining] = useState(0)
  const [workerResources, setWorkerResources] = useState(null)
  const wsRef = useRef(null)
  const logEndRef = useRef(null)
  const liveMatchedRef = useRef(false)
  const sweepRunsRef = useRef([])
  const prevRunStatusRef = useRef(null)
  const wsSignaledDoneRef = useRef(false)
  // Cancellation token: set to the numeric id of the run currently being shown.
  // loadRun and pollUntilFinished check this after every await — if the id has
  // changed we navigated away and the async work must not touch component state.
  const activeRunIdRef = useRef(null)

  async function loadRun() {
    const expectedId = Number(id)
    try {
      const data = await getRun(id)
      if (activeRunIdRef.current !== expectedId) return
      setRun(data)
      setError(null)
      if (data.status === 'completed') {
        getPrometheusSamples(id).then(setPromSamples).catch(() => {})
      }
      // NOTE: do NOT seed warmupStartedAt from data.started_at here.
      // started_at is the run start time (JVM init), not when warmup traffic begins.
      // Seeding it early causes the status badge to show "warming up" during
      // the initializing phase. Let the log line set it correctly.
    } catch (e) {
      if (activeRunIdRef.current !== expectedId) return
      setError(e.message)
    } finally {
      if (activeRunIdRef.current === expectedId) setLoading(false)
    }
  }

  // After the WebSocket signals completion the backend _finish_run task may
  // still be writing to the DB (it polls every 2 s).  Poll until the status
  // leaves "running" so the UI reflects the final result without a manual
  // refresh.
  async function pollUntilFinished() {
    const expectedId = Number(id)
    for (let i = 0; i < 20; i++) {
      await new Promise(r => setTimeout(r, 500))
      if (activeRunIdRef.current !== expectedId) return
      try {
        const data = await getRun(id)
        if (activeRunIdRef.current !== expectedId) return
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
    // Claim this id before any async work — stale pollUntilFinished/loadRun
    // instances check this ref after each await and bail if it changed.
    activeRunIdRef.current = Number(id)
    // Reset live streaming state only — deliberately keep run/sweepRuns/sweep so
    // chips stay visible during same-sweep navigation instead of flashing away.
    setLoading(true)
    setLivePoints([])
    setWarmupStartedAt(null)
    setBenchmarkStartedAt(null)
    liveMatchedRef.current = false
    wsSignaledDoneRef.current = false
    prevRunStatusRef.current = null
    setLogs([])
    setLogDone(false)
    setCooldownRemaining(0)

    loadRun()

    return () => {
      if (wsRef.current) { wsRef.current.close(); wsRef.current = null }
    }
  }, [id])

  useEffect(() => {
    getWorkerResources().then(setWorkerResources).catch(() => {})
  }, [])

  // Open WebSocket once the run is no longer pending.
  // Pending runs haven't been picked up by _execute_sweep yet — opening a WS
  // immediately would time out waiting for runner.is_started and close with
  // no logs. We wait here and let the pending-poll effect transition us to
  // 'running', at which point this effect fires and opens the connection.
  useEffect(() => {
    if (!run?.id) return
    if (run.id !== Number(id)) return  // stale run still in state while new id loads
    if (run.status === 'pending') return
    if (wsRef.current) return  // already opened for this run (even if now closed)

    const proto = window.location.protocol === 'https:' ? 'wss' : 'ws'
    const ws = new WebSocket(`${proto}://${window.location.host}/ws/runs/${run.id}`)
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
          wsSignaledDoneRef.current = true
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
      const e2eObj = parseE2ELatency(line)
      if (e2eObj !== null) {
        setLivePoints(prev => {
          if (prev.length === 0) return prev
          const last = { ...prev[prev.length - 1], ...e2eObj }
          return [...prev.slice(0, -1), last]
        })
      }
    }

    ws.onerror = () => { clearTimeout(warnTimer); setLogDone(true) }
    ws.onclose = () => { clearTimeout(warnTimer); setLogDone(true); pollUntilFinished() }
  }, [run?.id, run?.status, id])

  // Poll every 2 s while a sweep run is pending so the UI updates when
  // _execute_sweep eventually picks it up.
  useEffect(() => {
    if (run?.status !== 'pending') return
    const iv = setInterval(() => {
      getRun(id).then(data => { setRun(data); setError(null) }).catch(() => {})
    }, 2000)
    return () => clearInterval(iv)
  }, [id, run?.status])

  // Fetch Prometheus samples immediately and then every 5s while run is live
  useEffect(() => {
    if (run?.status !== 'running') return
    getPrometheusSamples(id).then(setPromSamples).catch(() => {})
    const interval = setInterval(() => {
      getPrometheusSamples(id).then(setPromSamples).catch(() => {})
    }, 5000)
    return () => clearInterval(interval)
  }, [id, run?.status])

  // Fetch sweep sibling runs and keep pills fresh while sweep is in progress.
  // Also fetch the sweep object itself to get cooldown_seconds for the timer.
  // When leaving a sweep context (sweep_id → null), clear chips explicitly.
  useEffect(() => {
    if (!run?.sweep_id) {
      setSweepRuns(null)
      sweepRunsRef.current = []
      setSweep(null)
      return
    }
    getSweep(run.sweep_id).then(setSweep).catch(() => {})
    function fetchSweepRuns() {
      getSweepRuns(run.sweep_id).then(runs => {
        setSweepRuns(runs)
        sweepRunsRef.current = runs
      }).catch(() => {})
    }
    fetchSweepRuns()
    const iv = setInterval(() => {
      const allDone = sweepRunsRef.current.every(r =>
        ['completed', 'failed', 'cancelled'].includes(r.status)
      )
      if (!allDone) fetchSweepRuns()
    }, 3000)
    return () => clearInterval(iv)
  }, [run?.sweep_id])

  // Auto-advance to next sweep run only when this one completes AND the WS
  // was live-streaming it (wsSignaledDoneRef). This prevents auto-advance when
  // the user manually navigates to a completed or pending run from the results
  // list — in those cases the WS never signals done mid-session.
  useEffect(() => {
    if (!run?.sweep_id) return
    const prev = prevRunStatusRef.current
    prevRunStatusRef.current = run.status  // always track for next transition
    if (!wsSignaledDoneRef.current) return
    if (prev !== 'running' || run.status !== 'completed') return
    const runs = sweepRunsRef.current
    const idx = runs.findIndex(sr => sr.id === run.id)
    if (idx !== -1 && idx < runs.length - 1) {
      navigate(`/runs/${runs[idx + 1].id}`)
    }
  }, [run?.status])

  // Cooldown countdown between sweep runs — anchored to server timestamp so it
  // survives navigation to other runs in the same sweep.
  // Shows when the current run is completed-and-next-is-pending, OR when the
  // current run is pending (user clicked ahead) and previous run just finished.
  useEffect(() => {
    if (!sweep?.cooldown_seconds || !sweepRuns || !run) {
      setCooldownRemaining(0)
      return
    }
    const idx = sweepRuns.findIndex(sr => sr.id === run.id)
    if (idx === -1) { setCooldownRemaining(0); return }

    let anchorCompletedAt = null
    if (run.status === 'completed' && idx < sweepRuns.length - 1 && sweepRuns[idx + 1]?.status === 'pending') {
      anchorCompletedAt = run.completed_at
    } else if (run.status === 'pending' && idx > 0 && sweepRuns[idx - 1]?.status === 'completed') {
      anchorCompletedAt = sweepRuns[idx - 1].completed_at
    }

    if (!anchorCompletedAt) { setCooldownRemaining(0); return }

    // SQLite stores naive UTC datetimes without 'Z'; append it so the browser
    // parses as UTC rather than local time (which would shift by timezone offset).
    const utcTs = anchorCompletedAt.endsWith('Z') ? anchorCompletedAt : anchorCompletedAt + 'Z'
    function tick() {
      const endTime = new Date(utcTs).getTime() + sweep.cooldown_seconds * 1000
      setCooldownRemaining(Math.max(0, Math.ceil((endTime - Date.now()) / 1000)))
    }
    tick()
    const iv = setInterval(tick, 1000)
    return () => clearInterval(iv)
  }, [run?.id, run?.status, run?.completed_at, sweep?.cooldown_seconds, sweepRuns])

  // Auto-scroll log only while actively streaming — not during WS replay of a
  // completed run, which would scroll to the bottom on every chip navigation.
  useEffect(() => {
    if (run?.status !== 'running') return
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

  if (loading && !run) return <div className="text-muted mt-20">Loading run…</div>
  if (error) return <div className="alert alert-error">{error}</div>
  if (!run) return null

  const m = run.metrics

  // Derive a finer-grained display status from live state + cooldown
  const displayStatus = run.status === 'running'
    ? (benchmarkStartedAt ? 'running' : warmupStartedAt ? 'warmup' : 'initializing')
    : cooldownRemaining > 0 ? 'cooldown'   // completed-and-waiting or pending-in-cooldown
    : run.status === 'pending' ? 'queued'
    : run.status

  const workloadParams = run?.workload_config ? parseWorkloadYaml(run.workload_config) : {}
  const messageSize = workloadParams?.values?.messageSize ?? 1024
  const warmupSamples = (workloadParams?.values?.warmupDurationMinutes ?? 1) * 60
  const totalSamples  = ((workloadParams?.values?.warmupDurationMinutes ?? 1) + (workloadParams?.values?.testDurationMinutes ?? 5)) * 60

  // Build a short label from sweep_params JSON, stripping Properties field prefixes
  function sweepParamLabel(sr) {
    try {
      const p = JSON.parse(sr.sweep_params || '{}')
      return Object.entries(p).map(([k, v]) => {
        const short = k.replace(/^(producerConfig|consumerConfig|topicConfig)\./, '')
        return `${short}=${v}`
      }).join(', ')
    } catch { return `Run #${sr.id}` }
  }

  return (
    <div>
      {run?.sweep_id && sweepRuns && (
        <div className="sweep-nav">
          <Link to={`/sweeps/${run.sweep_id}`} className="sweep-nav-back">
            ← Sweep #{run.sweep_id}
          </Link>
          <div className="sweep-nav-runs">
            {sweepRuns.map((sr, i) => (
              <Link
                key={sr.id}
                to={`/runs/${sr.id}`}
                className={`sweep-run-pill sweep-run-pill-${sr.status}${sr.id === run.id ? ' current' : ''}`}
              >
                {sweepParamLabel(sr) || `Run ${i + 1}`}
              </Link>
            ))}
          </div>
          {cooldownRemaining > 0 && (
            <div className="sweep-cooldown">
              🧊 {cooldownRemaining}s
            </div>
          )}
        </div>
      )}
      <div className="page-header">
        <div>
          <Link to="/" className="btn btn-secondary btn-sm">← Back to Runs</Link>
          <h1 className="page-title mt-8">
            Run #{run.id} {run.name && `— ${run.name}`}
          </h1>
          <div className="flex items-center gap-8 mt-4">
            <StatusBadge status={displayStatus} />
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

      {/* Error banner */}
      {run.status === 'failed' && run.error_message && (
        <div className="alert alert-error mt-8" style={{ display: 'flex', alignItems: 'flex-start', gap: 10 }}>
          <span style={{ fontWeight: 700, flexShrink: 0 }}>Run failed:</span>
          <span style={{ fontFamily: 'monospace', fontSize: 12 }}>{run.error_message}</span>
        </div>
      )}

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
        workerMemLimitMiB={workerResources?.memory_limit_mib ?? null}
        workerCpuCores={workerResources?.cpu_request_cores ?? null}
        runStartedAt={run?.started_at ?? null}
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
