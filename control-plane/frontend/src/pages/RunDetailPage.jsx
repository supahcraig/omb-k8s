import { useEffect, useRef, useState } from 'react'
import { useParams, Link, useNavigate } from 'react-router-dom'
import { getRun, cancelRun, getPrometheusSamples, getSweepRuns, getSweep, getWorkerResources, getRunResults } from '../api.js'
import RunCharts from '../components/RunCharts.jsx'
import FinalizedCharts from '../components/FinalizedCharts.jsx'
import { parseLiveMetric, parseE2ELatency } from '../lib/ombLogParser.js'
import { parseWorkloadYaml } from '../components/WorkloadForm.jsx'
import useGrafanaUrl from '../hooks/useGrafanaUrl.js'
import { buildRunGrafanaUrl } from '../lib/grafanaUtils.js'

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

function MetricCard({ label, value, unit, expected }) {
  const numeric = typeof value === 'string' ? parseFloat(value.replace(/,/g, '')) : value
  const hasExpected = expected != null && expected > 0
  const belowTarget = hasExpected && numeric != null && !isNaN(numeric) && numeric < expected * 0.95
  const atTarget    = hasExpected && numeric != null && !isNaN(numeric) && numeric >= expected * 0.95
  const valueColor  = belowTarget ? '#ef4444' : atTarget ? '#4ade80' : undefined
  return (
    <div className="metric-card">
      <div className="metric-label">{label}</div>
      <div className="metric-value" style={valueColor ? { color: valueColor } : undefined}>{value}</div>
      {unit && <div className="metric-unit">{unit}</div>}
      {hasExpected && (
        <div style={{ fontSize: 11, color: 'var(--color-text-muted)', marginTop: 4 }}>
          target: {expected.toLocaleString(undefined, { maximumFractionDigits: 0 })} {unit}
        </div>
      )}
    </div>
  )
}

function TileColumn({ label, badge, children }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 6, minHeight: 20 }}>
        <span style={{ fontSize: 10, color: 'var(--color-text-muted)', textTransform: 'uppercase', letterSpacing: '0.06em', fontWeight: 600 }}>
          {label}
        </span>
        {badge && <span className={`source-badge source-badge-${badge}`}>{badge}</span>}
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 8, flex: 1 }}>
        {children}
      </div>
    </div>
  )
}

function StubTile({ unit }) {
  return (
    <div style={{
      background: 'rgba(245,158,11,0.06)',
      border: '1px solid rgba(245,158,11,0.2)',
      borderRadius: 8,
      padding: '10px 14px',
    }}>
      <div style={{ fontSize: 22, fontWeight: 700, color: 'var(--color-text-muted)' }}>—</div>
      <div style={{ fontSize: 11, color: 'var(--color-text-muted)', marginTop: 2 }}>{unit}</div>
      <div style={{ fontSize: 10, color: 'rgba(245,158,11,0.5)', marginTop: 4 }}>not connected</div>
    </div>
  )
}

function LatencyColumn({ label, metrics, prefix, badge }) {
  const rows = [
    { key: 'avg',  rowLabel: 'Avg'  },
    { key: 'p50',  rowLabel: 'P50'  },
    { key: 'p99',  rowLabel: 'P99'  },
    { key: 'p999', rowLabel: 'P999' },
  ]
  return (
    <TileColumn label={label} badge={badge}>
      <div className="metric-card">
        <table style={{ width: '100%', borderCollapse: 'collapse' }}>
          <tbody>
            {rows.map(({ key, rowLabel }) => (
              <tr key={key}>
                <td style={{ fontSize: 11, color: 'var(--color-text-muted)', paddingBottom: 3 }}>{rowLabel}</td>
                <td style={{ fontSize: 13, fontWeight: 600, textAlign: 'right', paddingBottom: 3 }}>
                  {fmt(metrics[`${prefix}_latency_${key}`])} <span style={{ fontSize: 10, color: 'var(--color-text-muted)' }}>ms</span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </TileColumn>
  )
}



export default function RunDetailPage() {
  const { id } = useParams()
  const navigate = useNavigate()
  const grafanaUrl = useGrafanaUrl()
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
  const [hdrResults, setHdrResults] = useState(null)
  const [hdrLoading, setHdrLoading] = useState(false)
  const [logOpen, setLogOpen] = useState(true)
  const wsRef = useRef(null)
  const logEndRef = useRef(null)
  const liveMatchedRef = useRef(false)
  const wsHasDataRef = useRef(false)
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
      // Seed phase timestamps from the server so the timer is correct after navigation.
      // These are null until the backend detects the phase log lines.
      if (data.warmup_started_at) {
        const ts = new Date(data.warmup_started_at.endsWith('Z') ? data.warmup_started_at : data.warmup_started_at + 'Z').getTime()
        setWarmupStartedAt(ts)
      }
      if (data.benchmark_started_at) {
        const ts = new Date(data.benchmark_started_at.endsWith('Z') ? data.benchmark_started_at : data.benchmark_started_at + 'Z').getTime()
        setBenchmarkStartedAt(ts)
      }
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
    wsHasDataRef.current = false
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
          // Only trust this signal if the WS actually streamed real log lines.
          // A WS that fires 'done' immediately (runner race: is_done returns
          // true for unregistered run IDs) would otherwise trigger auto-advance
          // incorrectly when viewing a pending run that just transitioned to running.
          if (wsHasDataRef.current) {
            wsSignaledDoneRef.current = true
          }
          setLogDone(true)
          pollUntilFinished()
          return
        }
      } catch { /* not JSON — it's a log line */ }
      const line = evt.data
      wsHasDataRef.current = true
      setLogs(prev => [...prev, line])
      if (line.includes('Starting warm-up traffic'))  setWarmupStartedAt(prev => prev ?? Date.now())
      if (line.includes('Starting benchmark traffic')) setBenchmarkStartedAt(prev => prev ?? Date.now())
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

  // Fetch HDR results from the results file once run completes.
  // Retries on 404 — the file typically appears within 2-5s after completion.
  useEffect(() => {
    if (run?.status !== 'completed') return
    setHdrLoading(true)
    let cancelled = false
    async function fetchWithRetry(attempts = 8, delay = 1500) {
      for (let i = 0; i < attempts; i++) {
        if (cancelled) return
        try {
          const data = await getRunResults(id)
          if (!cancelled) { setHdrResults(data); setHdrLoading(false) }
          return
        } catch (e) {
          if (e.status !== 404) { setHdrLoading(false); return }
          if (i < attempts - 1) await new Promise(r => setTimeout(r, delay))
        }
      }
      if (!cancelled) setHdrLoading(false)
    }
    fetchWithRetry()
    return () => { cancelled = true }
  }, [id, run?.status])

  useEffect(() => {
    if (run?.status === 'completed') setLogOpen(false)
  }, [run?.status])

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

  const expectedMsgSec          = Number(workloadParams?.values?.producerRate) || 0
  const expectedMBSec           = expectedMsgSec * (Number(workloadParams?.values?.messageSize) || 1024) / 1_048_576
  const subscriptionsPerTopic   = Number(workloadParams?.values?.subscriptionsPerTopic) || 1
  const expectedConsMsgSec      = expectedMsgSec * subscriptionsPerTopic
  const expectedConsMBSec       = expectedMBSec  * subscriptionsPerTopic

  // Live publish/consume rates: average post-warmup livePoints
  const postWarmupPoints  = livePoints.filter(p => (p.t ?? 0) >= warmupSamples)
  const liveAvg           = key => postWarmupPoints.length > 0
    ? postWarmupPoints.reduce((s, p) => s + (p[key] ?? 0), 0) / postWarmupPoints.length
    : null
  const livePublishRate   = liveAvg('pubMsgSec')
  const livePublishMBSec  = liveAvg('pubMBSec')
  const liveConsumeRate   = liveAvg('consMsgSec')
  const liveConsumeMBSec  = liveAvg('consMBSec')

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
            {sweepRuns.map((sr, i) => {
              const prevRun = sweepRuns[i - 1]
              const isCooling = (() => {
                if (sr.status !== 'pending' || !prevRun || prevRun.status !== 'completed' || !prevRun.completed_at) return false
                if (!sweep?.cooldown_seconds) return false
                const ts = prevRun.completed_at.endsWith('Z') ? prevRun.completed_at : prevRun.completed_at + 'Z'
                return Date.now() < new Date(ts).getTime() + sweep.cooldown_seconds * 1000
              })()
              const pillStatus = isCooling ? 'cooling' : sr.status
              return (
                <Link
                  key={sr.id}
                  to={`/runs/${sr.id}`}
                  className={`sweep-run-pill sweep-run-pill-${pillStatus}${sr.id === run.id ? ' current' : ''}`}
                >
                  {sweepParamLabel(sr) || `Run ${i + 1}`}
                </Link>
              )
            })}
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
                Started {new Date(run.started_at.endsWith('Z') ? run.started_at : run.started_at + 'Z').toLocaleString()}
              </span>
            )}
            {run.completed_at && (
              <span className="text-muted text-small">
                Completed {new Date(run.completed_at.endsWith('Z') ? run.completed_at : run.completed_at + 'Z').toLocaleString()}
              </span>
            )}
            {grafanaUrl && run.started_at && (
              <a
                href={buildRunGrafanaUrl(grafanaUrl, run.started_at, run.completed_at)}
                target="_blank"
                rel="noopener noreferrer"
                className="badge"
                style={{ textDecoration: 'none', background: 'rgba(249,115,22,0.15)', color: '#f97316', border: '1px solid rgba(249,115,22,0.3)' }}
              >
                📊 Grafana ↗
              </a>
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

      {/* Post-completion finalized view */}
      {run.status === 'completed' && m && (
        <>
          {/* Throughput tiles — 2 columns only (actual vs target) */}
          <div style={{ display: 'inline-grid', gridTemplateColumns: 'auto auto', gap: 12, marginBottom: 16 }}>
            <TileColumn label="Avg Publish Rate" badge="omb">
              <MetricCard value={fmt(m.publish_rate_avg)} unit="msg/s" expected={expectedMsgSec > 0 ? expectedMsgSec : undefined} />
              <MetricCard value={fmt(m.publish_rate_avg * messageSize / 1_048_576, 2)} unit="MB/s" expected={expectedMBSec > 0 ? expectedMBSec : undefined} />
            </TileColumn>
            <TileColumn label="Avg Consume Rate" badge="omb">
              <MetricCard value={fmt(m.consume_rate_avg)} unit="msg/s" expected={expectedMsgSec > 0 ? expectedMsgSec : undefined} />
              <MetricCard value={fmt(m.consume_rate_avg * messageSize / 1_048_576, 2)} unit="MB/s" expected={expectedMBSec > 0 ? expectedMBSec : undefined} />
            </TileColumn>
          </div>

          {/* HDR finalized charts */}
          {hdrLoading && (
            <div style={{ color: 'var(--color-text-muted)', fontSize: 13, padding: '12px 0' }}>
              <span className="spinner spinner-dark" style={{ marginRight: 8 }} />
              Loading results…
            </div>
          )}
          {hdrResults && <FinalizedCharts results={hdrResults} warmupSamples={warmupSamples} />}

          {/* Run charts — throughput, backlog, worker metrics */}
          <div style={{ marginTop: 12 }}>
          <RunCharts
            livePoints={livePoints}
            metricsOut={run?.metrics ?? null}
            promSamples={promSamples}
            isLive={false}
            messageSize={messageSize}
            warmupSamples={warmupSamples}
            totalSamples={totalSamples}
            warmupStartedAt={warmupStartedAt}
            benchmarkStartedAt={benchmarkStartedAt}
            workerMemLimitMiB={workerResources?.memory_limit_mib ?? null}
            workerCpuCores={workerResources?.cpu_request_cores ?? null}
            runStartedAt={run?.started_at ?? null}
            expectedMsgSec={expectedMsgSec}
            expectedMBSec={expectedMBSec}
            expectedConsMsgSec={expectedConsMsgSec}
            expectedConsMBSec={expectedConsMBSec}
          />
          </div>
        </>
      )}

      {/* Live run charts — shown during active run */}
      {run.status !== 'completed' && (
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
          expectedMsgSec={expectedMsgSec}
          expectedMBSec={expectedMBSec}
          expectedConsMsgSec={expectedConsMsgSec}
          expectedConsMBSec={expectedConsMBSec}
        />
      )}

      {/* Log output */}
      <details
        className="card mt-20"
        style={{ padding: 0 }}
        open={logOpen}
        onToggle={e => setLogOpen(e.target.open)}
      >
        <summary style={{ padding: '12px 20px', cursor: 'pointer', fontWeight: 600, display: 'flex', alignItems: 'center', gap: 8 }}>
          <span style={{ fontSize: 10, marginRight: 2 }}>{logOpen ? '▼' : '▶'}</span>
          Run Log
          {!logDone && run.status === 'running' && (
            <span className="text-small text-muted flex items-center gap-8">
              <span className="spinner spinner-dark" /> Live streaming…
            </span>
          )}
        </summary>
        <div className="card-body" style={{ padding: 0 }}>
          <div className="log-viewer">
            {logs.length === 0 && !logDone ? 'Waiting for log output…' : logs.join('\n')}
            <div ref={logEndRef} />
          </div>
        </div>
      </details>

      {/* Config details */}
      <details className="card mt-20" style={{ padding: 0 }}>
        <summary style={{ padding: '12px 20px', cursor: 'pointer', fontWeight: 600, display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <span>Configuration YAML</span>
          <button
            type="button"
            className="btn btn-secondary btn-sm"
            style={{ fontWeight: 400 }}
            onClick={e => {
              e.preventDefault()
              navigate('/runs/new', { state: {
                driverContent: run.driver_config,
                workloadContent: run.workload_config,
                workloadName: run.name || `Run #${run.id}`,
              }})
            }}
          >
            ↺ Re-run with this config
          </button>
        </summary>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12, padding: '0 20px 20px' }}>
          <div>
            <div className="text-small text-muted mb-4">Driver</div>
            <pre className="log-viewer" style={{ maxHeight: 'none', fontSize: 11 }}>{run.driver_config}</pre>
          </div>
          <div>
            <div className="text-small text-muted mb-4">Workload</div>
            <pre className="log-viewer" style={{ maxHeight: 'none', fontSize: 11 }}>{run.workload_config}</pre>
          </div>
        </div>
      </details>
    </div>
  )
}
