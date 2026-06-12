import { useEffect, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { getTimelineRuns } from '../api.js'

function parseTs(ts) {
  if (!ts) return null
  return new Date(ts.endsWith('Z') ? ts : ts + 'Z')
}

function fmtTime(date) {
  if (!date) return ''
  return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })
}

const SWEEP_COLORS = [
  '#818cf8', '#f59e0b', '#34d399', '#f87171', '#60a5fa',
  '#a78bfa', '#fb923c', '#4ade80', '#e879f9', '#2dd4bf',
]
function sweepColor(sweepId, sweepIndex) {
  return SWEEP_COLORS[sweepIndex % SWEEP_COLORS.length]
}

const PHASE_COLORS = {
  init:      '#4b5563',
  warmup:    '#3b82f6',
  benchmark: '#22c55e',
}

const STATUS_COLORS = {
  completed: '#22c55e',
  failed:    '#ef4444',
  cancelled: '#f59e0b',
  running:   '#3b82f6',
  pending:   '#6b7280',
}

function buildSegments(run, nowMs) {
  const start  = parseTs(run.started_at)?.getTime()
  const warmup = parseTs(run.warmup_started_at)?.getTime()
  const bench  = parseTs(run.benchmark_started_at)?.getTime()
  const end    = parseTs(run.completed_at)?.getTime() ?? nowMs
  if (!start) return []
  if (!warmup) return [{ phase: 'init', start, end }]
  if (!bench)  return [{ phase: 'init', start, end: warmup }, { phase: 'warmup', start: warmup, end }]
  return [
    { phase: 'init',      start,        end: warmup },
    { phase: 'warmup',    start: warmup, end: bench },
    { phase: 'benchmark', start: bench,  end },
  ]
}

const LABEL_W = 180
const PAD_R   = 8
const PAD_TOP = 32
const ROW_H   = 30
const BAR_H   = 16
const BAR_PAD = (ROW_H - BAR_H) / 2

const MIN_SPAN_MS = 5 * 60 * 1000        // 5 minutes minimum zoom
const MAX_SPAN_MS = 30 * 24 * 3600 * 1000 // 30 days maximum zoom

function GanttChart({ runs, nowMs, viewStart, viewEnd, onViewChange }) {
  const navigate      = useNavigate()
  const containerRef  = useRef(null)
  const svgRef        = useRef(null)
  const dragRef       = useRef(null)
  const [containerWidth, setContainerWidth] = useState(800)

  useEffect(() => {
    if (!containerRef.current) return
    const ro = new ResizeObserver(entries => setContainerWidth(entries[0].contentRect.width))
    ro.observe(containerRef.current)
    return () => ro.disconnect()
  }, [])

  const chartW = containerWidth - LABEL_W - PAD_R

  // Only show runs that overlap the current view window
  const sweepIdToIndex = {}
  let sweepCounter = 0
  runs.forEach(r => {
    if (r.sweep_id != null && !(r.sweep_id in sweepIdToIndex))
      sweepIdToIndex[r.sweep_id] = sweepCounter++
  })

  const visibleRuns = runs.filter(r => {
    const start = parseTs(r.started_at)?.getTime()
    const end   = parseTs(r.completed_at)?.getTime() ?? nowMs
    return start != null && start < viewEnd && end > viewStart
  })

  const svgH = PAD_TOP + visibleRuns.length * ROW_H + 8

  function xOf(ms) {
    return ((ms - viewStart) / (viewEnd - viewStart)) * chartW
  }

  // Time axis ticks
  const TICK_COUNT = 6
  const ticks = Array.from({ length: TICK_COUNT + 1 }, (_, i) => ({
    ms: viewStart + ((viewEnd - viewStart) * i) / TICK_COUNT,
    x:  (chartW * i) / TICK_COUNT,
  }))

  function handleWheel(e) {
    e.preventDefault()
    const rect   = svgRef.current.getBoundingClientRect()
    const mouseX = e.clientX - rect.left
    const ratio  = Math.max(0, Math.min(1, mouseX / chartW))
    const span   = viewEnd - viewStart
    const factor = e.deltaY > 0 ? 1.3 : 0.77
    const newSpan = Math.max(MIN_SPAN_MS, Math.min(MAX_SPAN_MS, span * factor))
    const mouseMs = viewStart + ratio * span
    onViewChange(mouseMs - ratio * newSpan, mouseMs + (1 - ratio) * newSpan)
  }

  function handleMouseDown(e) {
    if (e.button !== 0) return
    e.preventDefault()
    dragRef.current = { startX: e.clientX, viewStart, viewEnd }
  }

  function handleMouseMove(e) {
    if (!dragRef.current) return
    const dx   = e.clientX - dragRef.current.startX
    const span = dragRef.current.viewEnd - dragRef.current.viewStart
    const dMs  = -(dx / chartW) * span
    onViewChange(dragRef.current.viewStart + dMs, dragRef.current.viewEnd + dMs)
  }

  function handleMouseUp() { dragRef.current = null }

  const clipId = 'gantt-clip'

  return (
    <div ref={containerRef} style={{ width: '100%' }}>
      <div style={{ display: 'flex', minWidth: 600, userSelect: 'none' }}>
        {/* Label column */}
        <div style={{ width: LABEL_W, flexShrink: 0 }}>
          <div style={{ height: PAD_TOP }} />
          {visibleRuns.map(run => {
            const isSweepRun = run.sweep_id != null
            const color = isSweepRun ? sweepColor(run.sweep_id, sweepIdToIndex[run.sweep_id]) : '#e2e8f0'
            return (
              <div
                key={run.id}
                onClick={() => navigate(`/runs/${run.id}`)}
                style={{
                  height: ROW_H, display: 'flex', alignItems: 'center',
                  paddingRight: 8, paddingLeft: isSweepRun ? 16 : 4,
                  cursor: 'pointer',
                  borderLeft: isSweepRun ? `3px solid ${color}` : '3px solid transparent',
                  overflow: 'hidden',
                }}
              >
                <span style={{ fontSize: 12, color: '#cbd5e1', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}
                  title={run.name || `Run #${run.id}`}>
                  {run.name || `Run #${run.id}`}
                </span>
              </div>
            )
          })}
        </div>

        {/* SVG chart */}
        <svg
          ref={svgRef}
          width={chartW + PAD_R}
          height={svgH}
          style={{ flexShrink: 0, cursor: dragRef.current ? 'grabbing' : 'grab' }}
          onWheel={handleWheel}
          onMouseDown={handleMouseDown}
          onMouseMove={handleMouseMove}
          onMouseUp={handleMouseUp}
          onMouseLeave={handleMouseUp}
        >
          <defs>
            <clipPath id={clipId}>
              <rect x={0} y={0} width={chartW} height={svgH} />
            </clipPath>
          </defs>

          {/* Time axis */}
          <line x1={0} y1={PAD_TOP - 1} x2={chartW} y2={PAD_TOP - 1} stroke="#374151" />
          {ticks.map((tick, i) => (
            <g key={i} transform={`translate(${tick.x}, 0)`}>
              <line y1={PAD_TOP - 5} y2={PAD_TOP} stroke="#6b7280" />
              <text y={PAD_TOP - 8}
                textAnchor={i === 0 ? 'start' : i === TICK_COUNT ? 'end' : 'middle'}
                fontSize={10} fill="#9ca3af">
                {fmtTime(new Date(tick.ms))}
              </text>
            </g>
          ))}

          {/* Bars (clipped to view) */}
          <g clipPath={`url(#${clipId})`}>
            {visibleRuns.map((run, rowIdx) => {
              const y         = PAD_TOP + rowIdx * ROW_H
              const segments  = buildSegments(run, nowMs)
              const isRunning = run.status === 'running'

              return (
                <g key={run.id} onClick={() => navigate(`/runs/${run.id}`)} style={{ cursor: 'pointer' }}>
                  <rect x={0} y={y} width={chartW} height={ROW_H} fill="transparent" className="gantt-row-hover" />

                  {segments.map((seg, si) => {
                    const sx = xOf(seg.start)
                    const ex = xOf(seg.end)
                    const w  = Math.max(ex - sx, 2)
                    return (
                      <rect key={si} x={sx} y={y + BAR_PAD} width={w} height={BAR_H}
                        fill={PHASE_COLORS[seg.phase]} rx={2} opacity={0.9} />
                    )
                  })}

                  {isRunning && segments.length > 0 && (() => {
                    const ex = xOf(segments[segments.length - 1].end)
                    return (
                      <rect x={ex - 4} y={y + BAR_PAD} width={4} height={BAR_H} fill="#ffffff" rx={1} opacity={0.5}>
                        <animate attributeName="opacity" values="0.5;1;0.5" dur="1.5s" repeatCount="indefinite" />
                      </rect>
                    )
                  })()}

                  {!isRunning && run.status !== 'pending' && (() => {
                    const end = parseTs(run.completed_at)?.getTime()
                    if (!end) return null
                    return <circle cx={xOf(end)} cy={y + ROW_H / 2} r={4} fill={STATUS_COLORS[run.status] || '#6b7280'} />
                  })()}

                  <rect x={0} y={y} width={chartW} height={ROW_H} fill="transparent" />
                </g>
              )
            })}

            {/* "Now" line */}
            {runs.some(r => r.status === 'running') && (() => {
              const nx = xOf(nowMs)
              if (nx < 0 || nx > chartW) return null
              return (
                <line x1={nx} y1={PAD_TOP} x2={nx} y2={svgH}
                  stroke="#f59e0b" strokeWidth={1} strokeDasharray="3,3" opacity={0.6} />
              )
            })()}
          </g>
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

      {!visibleRuns.length && (
        <div className="text-muted" style={{ paddingLeft: LABEL_W, marginTop: 12, fontSize: 13 }}>
          No runs in this time window.
        </div>
      )}
    </div>
  )
}

export default function TimelinePage() {
  const [runs, setRuns]           = useState([])
  const [loading, setLoading]     = useState(true)
  const [error, setError]         = useState(null)
  const [nowMs, setNowMs]         = useState(Date.now())
  const [viewStart, setViewStart] = useState(null)
  const [viewEnd, setViewEnd]     = useState(null)

  useEffect(() => {
    getTimelineRuns()
      .then(data => { setRuns(data); setLoading(false) })
      .catch(e  => { setError(e.message); setLoading(false) })
  }, [])

  // Default to last 1 hour on first load
  useEffect(() => {
    if (!runs.length || viewStart !== null) return
    const now = Date.now()
    setViewStart(now - 3600000)
    setViewEnd(now + 60000)
  }, [runs])

  useEffect(() => {
    if (!runs.some(r => r.status === 'running')) return
    const id = setInterval(() => setNowMs(Date.now()), 1000)
    return () => clearInterval(id)
  }, [runs])

  function setPreset(hours) {
    if (hours === 'all') {
      const allStarts = runs.map(r => parseTs(r.started_at)?.getTime()).filter(Boolean)
      const allEnds   = runs.map(r => parseTs(r.completed_at)?.getTime() ?? Date.now()).filter(Boolean)
      const minT = Math.min(...allStarts)
      const maxT = Math.max(...allEnds, Date.now())
      const span = maxT - minT || 3600000
      setViewStart(minT - span * 0.02)
      setViewEnd(maxT + span * 0.05)
    } else {
      const now = Date.now()
      setViewStart(now - hours * 3600000)
      setViewEnd(now + 60000)
    }
  }

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
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <span className="text-muted" style={{ fontSize: 12 }}>scroll to zoom · drag to pan</span>
          <div style={{ display: 'flex', gap: 4 }}>
            {[1, 3, 6].map(h => (
              <button key={h} type="button" className="btn btn-secondary btn-sm" onClick={() => setPreset(h)}>
                {h}h
              </button>
            ))}
            <button type="button" className="btn btn-secondary btn-sm" onClick={() => setPreset('all')}>
              All
            </button>
          </div>
        </div>
      </div>
      <div className="card">
        <div className="card-body" style={{ padding: '16px 20px' }}>
          {viewStart !== null && (
            <GanttChart
              runs={runs}
              nowMs={nowMs}
              viewStart={viewStart}
              viewEnd={viewEnd}
              onViewChange={(s, e) => { setViewStart(s); setViewEnd(e) }}
            />
          )}
        </div>
      </div>
    </div>
  )
}
