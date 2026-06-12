import { useEffect, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { getTimelineRuns } from '../api.js'

// Parse a SQLite UTC datetime string (no trailing Z) to a JS Date.
function parseTs(ts) {
  if (!ts) return null
  return new Date(ts.endsWith('Z') ? ts : ts + 'Z')
}

function fmtTime(date) {
  if (!date) return ''
  return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })
}

// Assign a distinct color per sweep_id (cycles through a palette).
const SWEEP_COLORS = [
  '#818cf8', '#f59e0b', '#34d399', '#f87171', '#60a5fa',
  '#a78bfa', '#fb923c', '#4ade80', '#e879f9', '#2dd4bf',
]
function sweepColor(sweepId, sweepIndex) {
  return SWEEP_COLORS[sweepIndex % SWEEP_COLORS.length]
}

const PHASE_COLORS = {
  init:      '#4b5563',  // gray
  warmup:    '#3b82f6',  // blue
  benchmark: '#22c55e',  // green
}

const STATUS_COLORS = {
  completed: '#22c55e',
  failed:    '#ef4444',
  cancelled: '#f59e0b',
  running:   '#3b82f6',
  pending:   '#6b7280',
}

// Build phase segments for a run bar.
// Returns [{phase, start, end}] in ascending start order.
function buildSegments(run, nowMs) {
  const start    = parseTs(run.started_at)?.getTime()
  const warmup   = parseTs(run.warmup_started_at)?.getTime()
  const bench    = parseTs(run.benchmark_started_at)?.getTime()
  const end      = parseTs(run.completed_at)?.getTime() ?? nowMs

  if (!start) return []

  const segments = []
  if (!warmup) {
    segments.push({ phase: 'init', start, end })
  } else if (!bench) {
    segments.push({ phase: 'init', start, end: warmup })
    segments.push({ phase: 'warmup', start: warmup, end })
  } else {
    segments.push({ phase: 'init',      start,  end: warmup })
    segments.push({ phase: 'warmup',    start: warmup, end: bench })
    segments.push({ phase: 'benchmark', start: bench,  end })
  }
  return segments
}

function GanttChart({ runs, nowMs }) {
  const navigate = useNavigate()
  const containerRef = useRef(null)
  const [containerWidth, setContainerWidth] = useState(800)

  useEffect(() => {
    if (!containerRef.current) return
    const ro = new ResizeObserver(entries => {
      setContainerWidth(entries[0].contentRect.width)
    })
    ro.observe(containerRef.current)
    return () => ro.disconnect()
  }, [])

  if (!runs.length) return null

  // Time range
  const allStarts = runs.map(r => parseTs(r.started_at)?.getTime()).filter(Boolean)
  const allEnds   = runs.map(r => (parseTs(r.completed_at)?.getTime() ?? nowMs)).filter(Boolean)
  const minTime = Math.min(...allStarts)
  const maxTime = Math.max(...allEnds, nowMs)
  const span    = maxTime - minTime || 1
  // 5% right padding
  const paddedMax = maxTime + span * 0.05
  const totalSpan = paddedMax - minTime

  const LABEL_W  = 180
  const PAD_R    = 8
  const PAD_TOP  = 32     // space for axis
  const ROW_H    = 30
  const BAR_H    = 16
  const BAR_PAD  = (ROW_H - BAR_H) / 2

  const chartW = containerWidth - LABEL_W - PAD_R
  const svgH   = PAD_TOP + runs.length * ROW_H + 8

  function xOf(ms) {
    return ((ms - minTime) / totalSpan) * chartW
  }

  // Build sweep index map for colors
  const sweepIdToIndex = {}
  let sweepCounter = 0
  runs.forEach(r => {
    if (r.sweep_id != null && !(r.sweep_id in sweepIdToIndex)) {
      sweepIdToIndex[r.sweep_id] = sweepCounter++
    }
  })

  // Time axis ticks
  const TICK_COUNT = 6
  const ticks = Array.from({ length: TICK_COUNT + 1 }, (_, i) => {
    const ms = minTime + (totalSpan * i) / TICK_COUNT
    return { ms, x: xOf(ms) }
  })

  return (
    <div ref={containerRef} style={{ width: '100%', overflowX: 'auto' }}>
      <div style={{ display: 'flex', minWidth: 600 }}>
        {/* Label column */}
        <div style={{ width: LABEL_W, flexShrink: 0 }}>
          {/* spacer for axis */}
          <div style={{ height: PAD_TOP }} />
          {runs.map(run => {
            const isSweepRun = run.sweep_id != null
            const color = isSweepRun ? sweepColor(run.sweep_id, sweepIdToIndex[run.sweep_id]) : '#e2e8f0'
            return (
              <div
                key={run.id}
                onClick={() => navigate(`/runs/${run.id}`)}
                style={{
                  height: ROW_H,
                  display: 'flex',
                  alignItems: 'center',
                  paddingRight: 8,
                  paddingLeft: isSweepRun ? 16 : 4,
                  cursor: 'pointer',
                  borderLeft: isSweepRun ? `3px solid ${color}` : '3px solid transparent',
                  overflow: 'hidden',
                }}
              >
                <span
                  style={{
                    fontSize: 12,
                    color: '#cbd5e1',
                    whiteSpace: 'nowrap',
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                  }}
                  title={run.name || `Run #${run.id}`}
                >
                  {run.name || `Run #${run.id}`}
                </span>
              </div>
            )
          })}
        </div>

        {/* SVG chart area */}
        <svg
          width={chartW + PAD_R}
          height={svgH}
          style={{ flexShrink: 0, cursor: 'default' }}
        >
          {/* Time axis */}
          <line x1={0} y1={PAD_TOP - 1} x2={chartW} y2={PAD_TOP - 1} stroke="#374151" />
          {ticks.map((tick, i) => (
            <g key={i} transform={`translate(${tick.x}, 0)`}>
              <line y1={PAD_TOP - 5} y2={PAD_TOP} stroke="#6b7280" />
              <text
                y={PAD_TOP - 8}
                textAnchor={i === 0 ? 'start' : i === TICK_COUNT ? 'end' : 'middle'}
                fontSize={10}
                fill="#9ca3af"
              >
                {fmtTime(new Date(tick.ms))}
              </text>
            </g>
          ))}

          {/* Row backgrounds + bars */}
          {runs.map((run, rowIdx) => {
            const y = PAD_TOP + rowIdx * ROW_H
            const segments = buildSegments(run, nowMs)
            const isRunning = run.status === 'running'
            const isSweepRun = run.sweep_id != null
            const sweepAccent = isSweepRun ? sweepColor(run.sweep_id, sweepIdToIndex[run.sweep_id]) : null

            return (
              <g
                key={run.id}
                onClick={() => navigate(`/runs/${run.id}`)}
                style={{ cursor: 'pointer' }}
              >
                {/* Hover stripe */}
                <rect
                  x={0} y={y}
                  width={chartW} height={ROW_H}
                  fill="transparent"
                  className="gantt-row-hover"
                />

                {/* Phase segments */}
                {segments.map((seg, si) => {
                  const sx = xOf(seg.start)
                  const ex = xOf(seg.end)
                  const w  = Math.max(ex - sx, 2)
                  return (
                    <rect
                      key={si}
                      x={sx} y={y + BAR_PAD}
                      width={w} height={BAR_H}
                      fill={PHASE_COLORS[seg.phase]}
                      rx={2}
                      opacity={0.9}
                    />
                  )
                })}

                {/* Running pulse — animated right edge */}
                {isRunning && segments.length > 0 && (() => {
                  const lastSeg = segments[segments.length - 1]
                  const ex = xOf(lastSeg.end)
                  return (
                    <rect
                      x={ex - 4} y={y + BAR_PAD}
                      width={4} height={BAR_H}
                      fill="#ffffff"
                      rx={1}
                      opacity={0.5}
                    >
                      <animate attributeName="opacity" values="0.5;1;0.5" dur="1.5s" repeatCount="indefinite" />
                    </rect>
                  )
                })()}

                {/* Status badge for non-running terminated runs */}
                {!isRunning && run.status !== 'pending' && segments.length > 0 && (() => {
                  const end = parseTs(run.completed_at)?.getTime()
                  if (!end) return null
                  const ex = xOf(end)
                  return (
                    <circle
                      cx={ex} cy={y + ROW_H / 2}
                      r={4}
                      fill={STATUS_COLORS[run.status] || '#6b7280'}
                    />
                  )
                })()}

                {/* Invisible full-row clickable area */}
                <rect x={0} y={y} width={chartW} height={ROW_H} fill="transparent" />
              </g>
            )
          })}

          {/* "Now" line for running runs */}
          {runs.some(r => r.status === 'running') && (() => {
            const nx = xOf(nowMs)
            if (nx < 0 || nx > chartW) return null
            return (
              <line
                x1={nx} y1={PAD_TOP}
                x2={nx} y2={svgH}
                stroke="#f59e0b"
                strokeWidth={1}
                strokeDasharray="3,3"
                opacity={0.6}
              />
            )
          })()}
        </svg>
      </div>

      {/* Legend */}
      <div style={{ display: 'flex', gap: 16, marginTop: 12, paddingLeft: LABEL_W, fontSize: 11, color: '#9ca3af' }}>
        {Object.entries(PHASE_COLORS).map(([phase, color]) => (
          <span key={phase} style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
            <span style={{ display: 'inline-block', width: 12, height: 10, background: color, borderRadius: 2 }} />
            {phase.charAt(0).toUpperCase() + phase.slice(1)}
          </span>
        ))}
        <span style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
          <span style={{ display: 'inline-block', width: 8, height: 8, background: '#f59e0b', borderRadius: '50%' }} />
          Now
        </span>
      </div>
    </div>
  )
}

export default function TimelinePage() {
  const [runs, setRuns]       = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError]     = useState(null)
  const [nowMs, setNowMs]     = useState(Date.now())

  useEffect(() => {
    getTimelineRuns()
      .then(data => { setRuns(data); setLoading(false) })
      .catch(e  => { setError(e.message); setLoading(false) })
  }, [])

  // Tick "now" every second so running bars extend live.
  useEffect(() => {
    if (!runs.some(r => r.status === 'running')) return
    const id = setInterval(() => setNowMs(Date.now()), 1000)
    return () => clearInterval(id)
  }, [runs])

  if (loading) return <div className="text-muted mt-20">Loading timeline…</div>
  if (error)   return <div className="alert alert-error">Failed to load timeline: {error}</div>
  if (!runs.length) return (
    <div>
      <div className="page-header"><h1 className="page-title">Timeline</h1></div>
      <div className="text-muted">No runs yet.</div>
    </div>
  )

  return (
    <div>
      <div className="page-header">
        <h1 className="page-title">Timeline</h1>
        <span className="text-muted" style={{ fontSize: 13 }}>
          {runs.length} run{runs.length !== 1 ? 's' : ''} — click any bar to view run details
        </span>
      </div>
      <div className="card">
        <div className="card-body" style={{ padding: '16px 20px' }}>
          <GanttChart runs={runs} nowMs={nowMs} />
        </div>
      </div>
    </div>
  )
}
