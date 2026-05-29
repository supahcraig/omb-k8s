import React, { useState, useEffect } from 'react';
import {
  LineChart, Line, XAxis, YAxis, CartesianGrid,
  Tooltip, Legend, ResponsiveContainer,
  ReferenceArea, ReferenceLine,
} from 'recharts';
import { normalizeTimeseries, promToChartData, computeLatencyStats } from '../lib/chartDataUtils.js';

const C = {
  grid:     '#2a3045',
  axis:     '#7a8399',
  publish:  '#e63946',
  consume:  '#4ade80',
  backlog:  '#f59e0b',
  pubP50:   '#6ee7b7',
  pubP99:   '#f59e0b',
  pubP999:  '#fcd34d',
  e2eP50:   '#6ee7b7',
  e2eP99:   '#fcd34d',
  e2eP999:  '#fb923c',
  bytesIn:       '#38bdf8',
  bytesOut:      '#7dd3fc',
  records:       '#a78bfa',
  workerCpu:     '#f97316',
  workerThrottle:'#ef4444',
  workerMem:     '#818cf8',
  pubLatencyGrid: 'rgba(245,158,11,0.2)',
  e2eLatencyGrid: 'rgba(252,211,77,0.15)',
};

// Round up to the next integer at the same order of magnitude (e.g. 6.2M → 7M)
function niceMax(value) {
  if (!value || value <= 0) return null
  const mag = Math.pow(10, Math.floor(Math.log10(value)))
  return (Math.floor(value / mag) + 1) * mag
}

function fmtMsgTick(v) {
  if (v >= 1e9) return `${+(v / 1e9).toFixed(1)}G`
  if (v >= 1e6) return `${+(v / 1e6).toFixed(1)}M`
  if (v >= 1e3) return `${+(v / 1e3).toFixed(0)}k`
  return String(v)
}

function fmtMBTick(v) {
  if (v >= 1000) return `${+(v / 1000).toFixed(1)}GB`
  if (v >= 1)    return `${+v.toFixed(1)}MB`
  return `${+(v * 1024).toFixed(0)}KB`
}

function _parseBase(isoString) {
  if (!isoString) return null;
  const s = isoString.endsWith('Z') ? isoString : isoString + 'Z';
  const ms = new Date(s).getTime();
  return isNaN(ms) ? null : ms;
}

function fmtTimeTick(baseMs, t) {
  if (!baseMs) return t;
  return new Date(baseMs + t * 1000).toLocaleTimeString([], {
    hour: '2-digit', minute: '2-digit', hour12: false,
  });
}

function fmtTimeLabel(baseMs, t) {
  if (!baseMs) return `t=${t}s`;
  return new Date(baseMs + t * 1000).toLocaleTimeString([], {
    hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
  });
}

const WORKER_COLORS = [
  '#818cf8', // indigo  — worker-0
  '#34d399', // emerald — worker-1
  '#f97316', // orange  — worker-2
  '#fbbf24', // amber   — worker-3
  '#a78bfa', // violet  — worker-4
  '#38bdf8', // sky     — worker-5
  '#fb923c', // light orange — worker-6
  '#4ade80', // green   — worker-7
];

function ChartCard({ title, badge, info, children }) {
  return (
    <div className="chart-card">
      <div className="chart-card-header">
        <span className="chart-card-title">{title}</span>
        {info && (
          <span className="chart-info-icon" title={info}>i</span>
        )}
        {badge && <span className={`source-badge source-badge-${badge}`}>{badge}</span>}
      </div>
      {children}
    </div>
  );
}

function LatencyStatsTable({ stats, keys, labels, colors, warmupNote }) {
  if (!stats) return null;
  const fmt = v => v == null ? '—' : v.toFixed(1);
  return (
    <div>
      {warmupNote && (
        <div style={{ fontSize: 10, color: 'var(--color-text-muted)', marginTop: 6, marginBottom: 2, fontStyle: 'italic' }}>
          warmup in progress — stats include warmup data
        </div>
      )}
      <table className="latency-stats-table">
        <thead>
          <tr><th>Percentile</th><th>Min</th><th>Mean</th><th>Max</th></tr>
        </thead>
        <tbody>
          {keys.map((k, i) => {
            const s = stats[k];
            const color = colors?.[i];
            return (
              <tr key={k}>
                <td style={color ? { color } : undefined}>{labels[i]}</td>
                <td>{s ? fmt(s.min) : '—'}</td>
                <td>{s ? fmt(s.mean) : '—'}</td>
                <td>{s ? fmt(s.max) : '—'}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

export default function RunCharts({
  livePoints = [],
  metricsOut = null,
  promSamples = [],
  isLive = false,
  messageSize = 1024,
  warmupSamples = 60,
  totalSamples = 360,
  warmupStartedAt = null,
  benchmarkStartedAt = null,
  workerMemLimitMiB = null,
  workerCpuCores = null,
  runStartedAt = null,
  expectedMsgSec      = 0,
  expectedMBSec       = 0,
  expectedConsMsgSec  = 0,
  expectedConsMBSec   = 0,
}) {
  const [, setTick] = useState(0)
  useEffect(() => {
    if (!isLive) return
    const id = setInterval(() => setTick(t => t + 1), 1000)
    return () => clearInterval(id)
  }, [isLive])

  // Keep live data once collected; only reconstruct from stored metrics when
  // viewing a historical run (livePoints empty, e.g. after page reload).
  const chartPoints = livePoints.length > 0 ? livePoints : (metricsOut ? normalizeTimeseries(metricsOut, messageSize) : []);
  const promPoints  = promToChartData(promSamples);
  const hasLatency      = chartPoints.some(p => p.pubP99 != null || p.pubP50 != null);
  const hasBrokerMetrics = promPoints.some(p => p.bytesInMBSec != null || p.bytesOutMBSec != null);
  const hasWorkerMetrics = promPoints.some(p => p.workerCpuPct != null || p.workerMemMiB != null);
  const maxThrottle      = promPoints.reduce((max, p) => Math.max(max, p.workerThrottlePct ?? 0), 0);
  const maxCpuPct        = promPoints.reduce((max, p) => {
    const podKeys = Object.keys(p).filter(k => k.startsWith('workerCpu_'));
    const podMax = podKeys.length > 0 ? Math.max(...podKeys.map(k => p[k] ?? 0)) : 0;
    return Math.max(max, podMax, p.workerCpuPct ?? 0);
  }, 0);

  // Progress bar driven by log-line timestamps: bar starts when warmup traffic
  // begins, green benchmark portion starts when benchmark traffic begins.
  const currentSamples = (isLive && warmupStartedAt)
    ? Math.max(0, (Date.now() - warmupStartedAt) / 1000)
    : chartPoints.length
  const progressPct = totalSamples > 0 ? Math.min(100, (currentSamples / totalSamples) * 100) : 0

  // Warmup divider: use actual elapsed time to benchmark start if known, else
  // fall back to the configured warmup duration.
  const warmupElapsed = (warmupStartedAt && benchmarkStartedAt)
    ? (benchmarkStartedAt - warmupStartedAt) / 1000
    : warmupSamples
  const warmupPct = totalSamples > 0 ? Math.min(100, (warmupElapsed / totalSamples) * 100) : 0

  // Exclude warmup from stats once we have post-warmup data, regardless of
  // live/complete state — avoids a visible flip in the stats table at completion.
  // Fall back to all data during warmup so the table isn't blank.
  // Always exclude warmup from stats — shows '—' during warmup phase, post-warmup data only after
  const statsWarmup = warmupSamples;
  const latencyStats = computeLatencyStats(chartPoints, statsWarmup);

  // Null out latency fields for warmup-period points so the latency charts auto-scale
  // to benchmark data only. Arrays stay the same length so syncId still works.
  // The warmup ReferenceArea provides visual context for the blank region.
  const latencyPoints = chartPoints.map((p, i) =>
    i < warmupSamples
      ? { ...p, pubP50: null, pubP99: null, pubP999: null, e2eP50: null, e2eP99: null, e2eP999: null }
      : p
  )

  const runStartedAtMs = _parseBase(runStartedAt);
  const ombTimeBase = warmupStartedAt ?? runStartedAtMs;
  const promTimeBase = runStartedAtMs;

  const workerPods = [...new Set(
    promPoints.flatMap(p =>
      Object.keys(p).filter(k => k.startsWith('workerMem_')).map(k => k.slice('workerMem_'.length))
    )
  )].sort();

  // Adaptive x-axis: short runs show HH:MM:SS, longer runs show HH:MM
  const isShortRun    = totalSamples <= 300
  const xTickInterval = totalSamples <= 300 ? 30 : totalSamples <= 1800 ? 300 : 600
  const xTicks        = Array.from({ length: Math.floor(totalSamples / xTickInterval) + 1 }, (_, i) => i * xTickInterval)
  const timeOpts      = isShortRun
    ? { hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' }
    : { hour12: false, hour: '2-digit', minute: '2-digit' }
  function xFmt(base) {
    return v => base
      ? new Date(base + v * 1000).toLocaleTimeString([], timeOpts)
      : isShortRun ? `${v}s` : `${Math.floor(v / 60)}m`
  }
  const ombXFmt  = xFmt(ombTimeBase)
  const promXFmt = xFmt(promTimeBase)

  if (!isLive && chartPoints.length === 0 && promPoints.length === 0) return null;

  return (
    <div className="run-charts">
      {/* Progress bar — only while run is live */}
      {isLive && <div className="run-progress">
        <div className="run-progress-bar">
          {/* Warmup fill: dark blue, 0 → min(progress, warmup) */}
          <div className="run-progress-fill" style={{
            width: `${Math.min(progressPct, warmupPct)}%`,
            background: '#1e40af',
          }} />
          {/* Benchmark fill: green, warmup → progress */}
          {progressPct > warmupPct && (
            <div className="run-progress-fill" style={{
              left: `${warmupPct}%`,
              width: `${Math.min(progressPct - warmupPct, 100 - warmupPct)}%`,
              background: '#4ade80',
            }} />
          )}
          {warmupPct > 0 && warmupPct < 100 && (
            <div className="run-progress-warmup-marker" style={{ left: `${warmupPct}%` }} />
          )}
        </div>
        <div className="run-progress-labels">
          <span>warmup {warmupSamples}s</span>
          <span>{Math.floor(currentSamples)}s / {totalSamples}s</span>
          {warmupStartedAt && currentSamples < totalSamples && (
            <span className="text-muted">{Math.ceil(totalSamples - currentSamples)}s remaining</span>
          )}
        </div>
      </div>}

      {/* CPU saturation alert */}
      {maxCpuPct > 85 && (
        <div style={{
          background: 'rgba(245,158,11,0.12)',
          border: '1px solid rgba(245,158,11,0.35)',
          borderRadius: 6,
          padding: '10px 14px',
          marginBottom: 12,
          color: '#fbbf24',
          fontSize: 13,
          lineHeight: 1.5,
        }}>
          ⚠ Workers are CPU-saturated (peak {maxCpuPct.toFixed(0)}%) — throughput may reflect worker capacity, not broker capacity. Scale up worker count to get accurate results.
        </div>
      )}

      {/* Throttle alert */}
      {maxThrottle > 10 && (
        <div style={{
          background: 'rgba(245,158,11,0.12)',
          border: '1px solid rgba(245,158,11,0.35)',
          borderRadius: 6,
          padding: '10px 14px',
          marginBottom: 12,
          color: '#fbbf24',
          fontSize: 13,
          lineHeight: 1.5,
        }}>
          ⚠ CPU throttling detected (peak {maxThrottle.toFixed(0)}%) — workers are being rate-limited by cgroup CPU limits. Throughput may be lower than broker capacity supports. Consider scaling up the number of worker pods.
        </div>
      )}

      {/* Row 1: 3-column OMB throughput */}
      <div className="charts-row charts-row-3">
        <ChartCard title="Throughput (msg/s)" badge="omb">
          <ResponsiveContainer width="100%" height={180}>
            <LineChart data={chartPoints} syncId="run">
              <CartesianGrid strokeDasharray="3 3" stroke={C.grid} />
              <XAxis dataKey="t" stroke={C.axis} tick={{ fill: C.axis, fontSize: 10 }} ticks={xTicks} tickFormatter={ombXFmt} />
              <YAxis stroke={C.axis} tick={{ fill: C.axis, fontSize: 10 }} width={55} tickFormatter={fmtMsgTick} domain={['auto', expectedMsgSec > 0 ? dataMax => niceMax(Math.max(dataMax, expectedMsgSec)) : 'auto']} />
              <Tooltip contentStyle={{ background: '#171c28', border: '1px solid #2a3045', color: '#e8edf8', fontSize: 11 }} labelFormatter={v => fmtTimeLabel(ombTimeBase, v)} />
              <Legend wrapperStyle={{ fontSize: 11, color: C.axis }} />
              {expectedMsgSec > 0 && (
                <ReferenceLine y={expectedMsgSec} stroke="rgba(245,158,11,0.7)" strokeDasharray="4 2" label={{ value: 'pub target', position: 'insideTopRight', fill: 'rgba(245,158,11,0.8)', fontSize: 10 }} />
              )}
              {expectedConsMsgSec > 0 && expectedConsMsgSec !== expectedMsgSec && (
                <ReferenceLine y={expectedConsMsgSec} stroke="rgba(74,222,128,0.6)" strokeDasharray="4 2" label={{ value: 'cons target', position: 'insideBottomRight', fill: 'rgba(74,222,128,0.7)', fontSize: 10 }} />
              )}
              <Line type="monotone" dataKey="pubMsgSec"  name="publish"  stroke={C.publish} dot={false} strokeWidth={2} />
              <Line type="monotone" dataKey="consMsgSec" name="consume"  stroke={C.consume} dot={false} strokeWidth={1.5} strokeDasharray="5 3" />
            </LineChart>
          </ResponsiveContainer>
        </ChartCard>

        <ChartCard title="Throughput (MB/s)" badge="omb">
          <ResponsiveContainer width="100%" height={180}>
            <LineChart data={chartPoints} syncId="run">
              <CartesianGrid strokeDasharray="3 3" stroke={C.grid} />
              <XAxis dataKey="t" stroke={C.axis} tick={{ fill: C.axis, fontSize: 10 }} ticks={xTicks} tickFormatter={ombXFmt} />
              <YAxis stroke={C.axis} tick={{ fill: C.axis, fontSize: 10 }} width={55} tickFormatter={fmtMBTick} domain={['auto', expectedMBSec > 0 ? dataMax => niceMax(Math.max(dataMax, expectedMBSec)) : 'auto']} />
              <Tooltip contentStyle={{ background: '#171c28', border: '1px solid #2a3045', color: '#e8edf8', fontSize: 11 }} labelFormatter={v => fmtTimeLabel(ombTimeBase, v)} />
              <Legend wrapperStyle={{ fontSize: 11, color: C.axis }} />
              {expectedMBSec > 0 && (
                <ReferenceLine y={expectedMBSec} stroke="rgba(245,158,11,0.7)" strokeDasharray="4 2" label={{ value: 'pub target', position: 'insideTopRight', fill: 'rgba(245,158,11,0.8)', fontSize: 10 }} />
              )}
              {expectedConsMBSec > 0 && expectedConsMBSec !== expectedMBSec && (
                <ReferenceLine y={expectedConsMBSec} stroke="rgba(74,222,128,0.6)" strokeDasharray="4 2" label={{ value: 'cons target', position: 'insideBottomRight', fill: 'rgba(74,222,128,0.7)', fontSize: 10 }} />
              )}
              <Line type="monotone" dataKey="pubMBSec"  name="publish"  stroke={C.publish} dot={false} strokeWidth={2} />
              <Line type="monotone" dataKey="consMBSec" name="consume"  stroke={C.consume} dot={false} strokeWidth={1.5} strokeDasharray="5 3" />
            </LineChart>
          </ResponsiveContainer>
        </ChartCard>

        <ChartCard title="Backlog (msgs)" badge="omb">
          <ResponsiveContainer width="100%" height={180}>
            <LineChart data={chartPoints} syncId="run">
              <CartesianGrid strokeDasharray="3 3" stroke={C.grid} />
              <XAxis dataKey="t" stroke={C.axis} tick={{ fill: C.axis, fontSize: 10 }} ticks={xTicks} tickFormatter={ombXFmt} />
              <YAxis stroke={C.axis} tick={{ fill: C.axis, fontSize: 10 }} width={65} domain={[0, 'auto']} tickFormatter={v => v.toLocaleString()} />
              <Tooltip contentStyle={{ background: '#171c28', border: '1px solid #2a3045', color: '#e8edf8', fontSize: 11 }} formatter={v => [v.toLocaleString(), 'backlog']} labelFormatter={v => fmtTimeLabel(ombTimeBase, v)} />
              <Line type="monotone" dataKey="backlog" name="backlog" stroke={C.backlog} dot={false} strokeWidth={2} />
            </LineChart>
          </ResponsiveContainer>
        </ChartCard>
      </div>

      {/* Row 2: 2-column latency (only if we have latency data) */}
      {hasLatency && (
        <div className="charts-row charts-row-2">
          <ChartCard title="Publish Latency (ms)" badge="omb">
            <ResponsiveContainer width="100%" height={180}>
              <LineChart data={latencyPoints} syncId="run">
                <CartesianGrid strokeDasharray="3 3" stroke={C.pubLatencyGrid} />
                <XAxis dataKey="t" stroke={C.axis} tick={{ fill: C.axis, fontSize: 10 }} ticks={xTicks} tickFormatter={ombXFmt} />
                <YAxis stroke={C.axis} tick={{ fill: C.axis, fontSize: 10 }} width={50} />
                <Tooltip contentStyle={{ background: '#171c28', border: '1px solid #2a3045', color: '#e8edf8', fontSize: 11 }} labelFormatter={v => fmtTimeLabel(ombTimeBase, v)} />
                <Legend wrapperStyle={{ fontSize: 11, color: C.axis }} />
                {warmupSamples > 0 && chartPoints.length > 0 && (
                  <ReferenceArea x1={0} x2={Math.min(warmupSamples, chartPoints[chartPoints.length - 1].t)} fill="rgba(255,255,255,0.04)" />
                )}
                <Line type="monotone" dataKey="pubP50"  name="p50"   stroke={C.pubP50}  dot={false} strokeWidth={1.5} strokeDasharray="4 2" connectNulls />
                <Line type="monotone" dataKey="pubP99"  name="p99"   stroke={C.pubP99}  dot={false} strokeWidth={2} connectNulls />
                <Line type="monotone" dataKey="pubP999" name="p99.9" stroke={C.pubP999} dot={false} strokeWidth={1.5} strokeDasharray="2 2" connectNulls />
              </LineChart>
            </ResponsiveContainer>
            <LatencyStatsTable
              stats={latencyStats}
              keys={['pubP50', 'pubP99', 'pubP999']}
              labels={['P50', 'P99', 'P99.9']}
              colors={[C.pubP50, C.pubP99, C.pubP999]}
              warmupNote={isLive && currentSamples <= warmupSamples}
            />
          </ChartCard>

          <ChartCard title="E2E Latency (ms)" badge="omb">
            <ResponsiveContainer width="100%" height={180}>
              <LineChart data={latencyPoints} syncId="run">
                <CartesianGrid strokeDasharray="3 3" stroke={C.e2eLatencyGrid} />
                <XAxis dataKey="t" stroke={C.axis} tick={{ fill: C.axis, fontSize: 10 }} ticks={xTicks} tickFormatter={ombXFmt} />
                <YAxis stroke={C.axis} tick={{ fill: C.axis, fontSize: 10 }} width={50} />
                <Tooltip contentStyle={{ background: '#171c28', border: '1px solid #2a3045', color: '#e8edf8', fontSize: 11 }} labelFormatter={v => fmtTimeLabel(ombTimeBase, v)} />
                <Legend wrapperStyle={{ fontSize: 11, color: C.axis }} />
                {warmupSamples > 0 && chartPoints.length > 0 && (
                  <ReferenceArea x1={0} x2={Math.min(warmupSamples, chartPoints[chartPoints.length - 1].t)} fill="rgba(255,255,255,0.04)" />
                )}
                <Line type="monotone" dataKey="e2eP50"  name="p50"   stroke={C.e2eP50}  dot={false} strokeWidth={1.5} strokeDasharray="4 2" connectNulls />
                <Line type="monotone" dataKey="e2eP99"  name="p99"   stroke={C.e2eP99}  dot={false} strokeWidth={2} connectNulls />
                <Line type="monotone" dataKey="e2eP999" name="p99.9" stroke={C.e2eP999} dot={false} strokeWidth={1.5} strokeDasharray="2 2" connectNulls />
              </LineChart>
            </ResponsiveContainer>
            <LatencyStatsTable
              stats={latencyStats}
              keys={['e2eP50', 'e2eP99', 'e2eP999']}
              labels={['P50', 'P99', 'P99.9']}
              colors={[C.e2eP50, C.e2eP99, C.e2eP999]}
              warmupNote={isLive && currentSamples <= warmupSamples}
            />
          </ChartCard>
        </div>
      )}

      {/* Row 3: Broker Prometheus (only if broker metrics available) */}
      {hasBrokerMetrics && (
        <div className="charts-row charts-row-2">
          <ChartCard title="Broker Bytes In/Out (MB/s)" badge="redpanda">
            <ResponsiveContainer width="100%" height={180}>
              <LineChart data={promPoints} syncId="run">
                <CartesianGrid strokeDasharray="3 3" stroke={C.grid} />
                <XAxis dataKey="t" stroke={C.axis} tick={{ fill: C.axis, fontSize: 10 }} ticks={xTicks} tickFormatter={promXFmt} />
                <YAxis stroke={C.axis} tick={{ fill: C.axis, fontSize: 10 }} width={50} />
                <Tooltip contentStyle={{ background: '#171c28', border: '1px solid #2a3045', color: '#e8edf8', fontSize: 11 }} labelFormatter={v => fmtTimeLabel(promTimeBase, v)} />
                <Legend wrapperStyle={{ fontSize: 11, color: C.axis }} />
                <Line type="monotone" dataKey="bytesInMBSec"  name="bytes in"  stroke={C.bytesIn}  dot={false} strokeWidth={2} />
                <Line type="monotone" dataKey="bytesOutMBSec" name="bytes out" stroke={C.bytesOut} dot={false} strokeWidth={1.5} strokeDasharray="5 3" />
              </LineChart>
            </ResponsiveContainer>
          </ChartCard>

          <ChartCard title="Records / sec" badge="redpanda">
            <ResponsiveContainer width="100%" height={180}>
              <LineChart data={promPoints} syncId="run">
                <CartesianGrid strokeDasharray="3 3" stroke={C.grid} />
                <XAxis dataKey="t" stroke={C.axis} tick={{ fill: C.axis, fontSize: 10 }} ticks={xTicks} tickFormatter={promXFmt} />
                <YAxis stroke={C.axis} tick={{ fill: C.axis, fontSize: 10 }} width={50} />
                <Tooltip contentStyle={{ background: '#171c28', border: '1px solid #2a3045', color: '#e8edf8', fontSize: 11 }} labelFormatter={v => fmtTimeLabel(promTimeBase, v)} />
                <Line type="monotone" dataKey="recordsPerSec" name="records/sec" stroke={C.records} dot={false} strokeWidth={2} />
              </LineChart>
            </ResponsiveContainer>
          </ChartCard>
        </div>
      )}

      {/* Row 4: Worker resource charts */}
      {(hasWorkerMetrics || isLive) && (
        <div className="charts-row charts-row-2">
          <ChartCard
            title="Worker CPU (%)"
            badge="worker"
            info={`CPU Usage: how much of the ${workerCpuCores != null ? workerCpuCores : 4}-core worker allocation the workers are consuming. Throttled: fraction of CPU scheduling slots the kernel rejected because the worker exceeded its cgroup quota. No CPU limit is set so throttle will always be 0 — any non-zero throttle value indicates a misconfiguration. Above 85% (amber line) workers are CPU-saturated and throughput reflects worker capacity, not broker capacity — scale up worker count. Above 100% (red line) workers are exceeding their CPU request and competing with node overhead.`}
          >
            <ResponsiveContainer width="100%" height={180}>
              <LineChart data={promPoints} syncId="run">
                <CartesianGrid strokeDasharray="3 3" stroke={C.grid} />
                <XAxis dataKey="t" stroke={C.axis} tick={{ fill: C.axis, fontSize: 10 }} ticks={xTicks} tickFormatter={promXFmt} />
                <YAxis stroke={C.axis} tick={{ fill: C.axis, fontSize: 10 }} width={50} domain={[0, 'auto']} />
                <Tooltip contentStyle={{ background: '#171c28', border: '1px solid #2a3045', color: '#e8edf8', fontSize: 11 }} formatter={(v, name) => [v != null ? `${v.toFixed(1)}%` : '—', name]} labelFormatter={v => fmtTimeLabel(promTimeBase, v)} />
                <Legend wrapperStyle={{ fontSize: 11, color: C.axis }} />
                <ReferenceLine y={85} stroke="rgba(239,68,68,0.5)" strokeDasharray="4 2" label={{ value: '85%', position: 'insideTopRight', fill: 'rgba(239,68,68,0.7)', fontSize: 10 }} />
                <ReferenceLine y={100} stroke="rgba(239,68,68,0.7)" />
                {workerPods.length > 0
                  ? workerPods.map((pod, i) => (
                      <Line
                        key={`cpu-${pod}`}
                        type="monotone"
                        dataKey={`workerCpu_${pod}`}
                        name={pod.replace('omb-worker-', 'worker-')}
                        stroke={WORKER_COLORS[i % WORKER_COLORS.length]}
                        dot={false}
                        strokeWidth={2}
                        connectNulls
                      />
                    ))
                  : <Line type="monotone" dataKey="workerCpuPct" name="cpu usage" stroke={C.workerCpu} dot={false} strokeWidth={2} connectNulls />
                }
                <Line type="monotone" dataKey="workerThrottlePct" name="throttled" stroke={C.workerThrottle} dot={false} strokeWidth={1.5} strokeDasharray="4 2" connectNulls />
              </LineChart>
            </ResponsiveContainer>
          </ChartCard>

          <ChartCard title="Worker Memory (GiB)" badge="worker">
            <ResponsiveContainer width="100%" height={180}>
              <LineChart data={promPoints} syncId="run">
                <CartesianGrid strokeDasharray="3 3" stroke={C.grid} />
                <XAxis dataKey="t" stroke={C.axis} tick={{ fill: C.axis, fontSize: 10 }} ticks={xTicks} tickFormatter={promXFmt} />
                <YAxis
                  stroke={C.axis}
                  tick={{ fill: C.axis, fontSize: 10 }}
                  width={50}
                  domain={[0, 'auto']}
                  tickFormatter={v => (v / 1024).toFixed(1)}
                />
                <Tooltip
                  contentStyle={{ background: '#171c28', border: '1px solid #2a3045', color: '#e8edf8', fontSize: 11 }}
                  labelFormatter={v => fmtTimeLabel(promTimeBase, v)}
                  formatter={(v, name) => [v != null ? `${(v / 1024).toFixed(2)} GiB` : '—', name]}
                />
                <Legend wrapperStyle={{ fontSize: 11, color: C.axis }} />
                <ReferenceLine
                  y={workerMemLimitMiB != null ? workerMemLimitMiB : 8192}
                  stroke="rgba(239,68,68,0.4)"
                  strokeDasharray="4 2"
                  label={{
                    value: workerMemLimitMiB != null
                      ? `${Math.round(workerMemLimitMiB / 1024)} GiB limit`
                      : '8 GiB limit',
                    fill: 'rgba(239,68,68,0.7)',
                    fontSize: 10,
                    position: 'insideTopRight',
                  }}
                />
                {workerPods.length > 0
                  ? workerPods.map((pod, i) => (
                      <Line
                        key={`mem-${pod}`}
                        type="monotone"
                        dataKey={`workerMem_${pod}`}
                        name={pod.replace('omb-worker-', 'worker-')}
                        stroke={WORKER_COLORS[i % WORKER_COLORS.length]}
                        dot={false}
                        strokeWidth={2}
                        connectNulls
                      />
                    ))
                  : <Line type="monotone" dataKey="workerMemMiB" name="memory" stroke={C.workerMem} dot={false} strokeWidth={2} connectNulls />
                }
              </LineChart>
            </ResponsiveContainer>
          </ChartCard>
        </div>
      )}
    </div>
  );
}
