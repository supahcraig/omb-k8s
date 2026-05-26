import React from 'react';
import {
  LineChart, Line, XAxis, YAxis, CartesianGrid,
  Tooltip, Legend, ResponsiveContainer,
  ReferenceArea,
} from 'recharts';
import { normalizeTimeseries, promToChartData, computeLatencyStats } from '../lib/chartDataUtils.js';

function ChartCard({ title, badge, children }) {
  return (
    <div className="chart-card">
      <div className="chart-card-header">
        <span className="chart-card-title">{title}</span>
        {badge && <span className={`source-badge source-badge-${badge}`}>{badge}</span>}
      </div>
      {children}
    </div>
  );
}

function LatencyStatsTable({ stats, keys, labels, warmupNote }) {
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
            return (
              <tr key={k}>
                <td>{labels[i]}</td>
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

export default function RunCharts({ livePoints = [], metricsOut = null, promSamples = [], isLive = false, messageSize = 1024, warmupSamples = 60, totalSamples = 360 }) {
  // Keep live data once collected; only reconstruct from stored metrics when
  // viewing a historical run (livePoints empty, e.g. after page reload).
  const chartPoints = livePoints.length > 0 ? livePoints : (metricsOut ? normalizeTimeseries(metricsOut, messageSize) : []);
  const promPoints  = promToChartData(promSamples);
  const hasLatency  = chartPoints.some(p => p.pubP99 != null || p.pubP50 != null);

  const currentSamples = chartPoints.length;
  const progressPct    = totalSamples > 0 ? Math.min(100, (currentSamples / totalSamples) * 100) : 0;
  const warmupPct      = totalSamples > 0 ? Math.min(100, (warmupSamples / totalSamples) * 100) : 0;

  // During a live run show stats for all collected data so the table isn't
  // blank for the entire warmup period. Post-run, exclude warmup for accuracy.
  const statsWarmup = isLive ? 0 : warmupSamples;
  const latencyStats = computeLatencyStats(chartPoints, statsWarmup);

  if (chartPoints.length === 0 && promPoints.length === 0) return null;

  return (
    <div className="run-charts">
      {/* Progress bar */}
      <div className="run-progress">
        <div className="run-progress-bar">
          {warmupPct > 0 && (
            <div className="run-progress-warmup-region" style={{ width: `${warmupPct}%` }} />
          )}
          <div className="run-progress-fill" style={{ width: `${progressPct}%` }} />
          {warmupPct > 0 && warmupPct < 100 && (
            <div className="run-progress-warmup-marker" style={{ left: `${warmupPct}%` }} />
          )}
        </div>
        <div className="run-progress-labels">
          <span>warmup {warmupSamples}s</span>
          <span>{currentSamples}s / {totalSamples}s</span>
        </div>
      </div>

      {/* Row 1: 3-column OMB throughput */}
      <div className="charts-row charts-row-3">
        <ChartCard title="Throughput (msg/s)" badge="omb">
          <ResponsiveContainer width="100%" height={180}>
            <LineChart data={chartPoints} syncId="run">
              <CartesianGrid strokeDasharray="3 3" stroke="#2a3045" />
              <XAxis dataKey="t" stroke="#7a8399" tick={{ fill: '#7a8399', fontSize: 10 }} />
              <YAxis stroke="#7a8399" tick={{ fill: '#7a8399', fontSize: 10 }} width={50} />
              <Tooltip contentStyle={{ background: '#171c28', border: '1px solid #2a3045', color: '#e8edf8', fontSize: 11 }} />
              <Legend wrapperStyle={{ fontSize: 11, color: '#7a8399' }} />
              <Line type="monotone" dataKey="pubMsgSec"  name="publish"  stroke="#e63946" dot={false} strokeWidth={2} />
              <Line type="monotone" dataKey="consMsgSec" name="consume"  stroke="#4ade80" dot={false} strokeWidth={1.5} strokeDasharray="5 3" />
            </LineChart>
          </ResponsiveContainer>
        </ChartCard>

        <ChartCard title="Throughput (MB/s)" badge="omb">
          <ResponsiveContainer width="100%" height={180}>
            <LineChart data={chartPoints} syncId="run">
              <CartesianGrid strokeDasharray="3 3" stroke="#2a3045" />
              <XAxis dataKey="t" stroke="#7a8399" tick={{ fill: '#7a8399', fontSize: 10 }} />
              <YAxis stroke="#7a8399" tick={{ fill: '#7a8399', fontSize: 10 }} width={50} />
              <Tooltip contentStyle={{ background: '#171c28', border: '1px solid #2a3045', color: '#e8edf8', fontSize: 11 }} />
              <Legend wrapperStyle={{ fontSize: 11, color: '#7a8399' }} />
              <Line type="monotone" dataKey="pubMBSec"  name="publish"  stroke="#e63946" dot={false} strokeWidth={2} />
              <Line type="monotone" dataKey="consMBSec" name="consume"  stroke="#4ade80" dot={false} strokeWidth={1.5} strokeDasharray="5 3" />
            </LineChart>
          </ResponsiveContainer>
        </ChartCard>

        <ChartCard title="Backlog (K msgs)" badge="omb">
          <ResponsiveContainer width="100%" height={180}>
            <LineChart data={chartPoints} syncId="run">
              <CartesianGrid strokeDasharray="3 3" stroke="#2a3045" />
              <XAxis dataKey="t" stroke="#7a8399" tick={{ fill: '#7a8399', fontSize: 10 }} />
              <YAxis stroke="#7a8399" tick={{ fill: '#7a8399', fontSize: 10 }} width={50} />
              <Tooltip contentStyle={{ background: '#171c28', border: '1px solid #2a3045', color: '#e8edf8', fontSize: 11 }} />
              <Line type="monotone" dataKey="backlog" name="backlog" stroke="#f59e0b" dot={false} strokeWidth={2} />
            </LineChart>
          </ResponsiveContainer>
        </ChartCard>
      </div>

      {/* Row 2: 2-column latency (only if we have latency data) */}
      {hasLatency && (
        <div className="charts-row charts-row-2">
          <ChartCard title="Publish Latency (ms)" badge="omb">
            <ResponsiveContainer width="100%" height={180}>
              <LineChart data={chartPoints} syncId="run">
                <CartesianGrid strokeDasharray="3 3" stroke="#2a3045" />
                <XAxis dataKey="t" stroke="#7a8399" tick={{ fill: '#7a8399', fontSize: 10 }} />
                <YAxis stroke="#7a8399" tick={{ fill: '#7a8399', fontSize: 10 }} width={50} />
                <Tooltip contentStyle={{ background: '#171c28', border: '1px solid #2a3045', color: '#e8edf8', fontSize: 11 }} />
                <Legend wrapperStyle={{ fontSize: 11, color: '#7a8399' }} />
                {warmupSamples > 0 && chartPoints.length > 0 && (
                  <ReferenceArea x1={0} x2={Math.min(warmupSamples, chartPoints[chartPoints.length - 1].t)} fill="rgba(255,255,255,0.04)" />
                )}
                <Line type="monotone" dataKey="pubP50"  name="p50"   stroke="#6ee7b7" dot={false} strokeWidth={1.5} strokeDasharray="4 2" connectNulls />
                <Line type="monotone" dataKey="pubP99"  name="p99"   stroke="#f59e0b" dot={false} strokeWidth={2} connectNulls />
                <Line type="monotone" dataKey="pubP999" name="p99.9" stroke="#fcd34d" dot={false} strokeWidth={1.5} strokeDasharray="2 2" connectNulls />
              </LineChart>
            </ResponsiveContainer>
            <LatencyStatsTable
              stats={latencyStats}
              keys={['pubP50', 'pubP99', 'pubP999']}
              labels={['P50', 'P99', 'P99.9']}
              warmupNote={isLive && currentSamples <= warmupSamples}
            />
          </ChartCard>

          <ChartCard title="E2E Latency (ms)" badge="omb">
            <ResponsiveContainer width="100%" height={180}>
              <LineChart data={chartPoints} syncId="run">
                <CartesianGrid strokeDasharray="3 3" stroke="#2a3045" />
                <XAxis dataKey="t" stroke="#7a8399" tick={{ fill: '#7a8399', fontSize: 10 }} />
                <YAxis stroke="#7a8399" tick={{ fill: '#7a8399', fontSize: 10 }} width={50} />
                <Tooltip contentStyle={{ background: '#171c28', border: '1px solid #2a3045', color: '#e8edf8', fontSize: 11 }} />
                <Legend wrapperStyle={{ fontSize: 11, color: '#7a8399' }} />
                {warmupSamples > 0 && chartPoints.length > 0 && (
                  <ReferenceArea x1={0} x2={Math.min(warmupSamples, chartPoints[chartPoints.length - 1].t)} fill="rgba(255,255,255,0.04)" />
                )}
                <Line type="monotone" dataKey="e2eP50"  name="p50"   stroke="#6ee7b7" dot={false} strokeWidth={1.5} strokeDasharray="4 2" connectNulls />
                <Line type="monotone" dataKey="e2eP99"  name="p99"   stroke="#fcd34d" dot={false} strokeWidth={2} connectNulls />
                <Line type="monotone" dataKey="e2eP999" name="p99.9" stroke="#fb923c" dot={false} strokeWidth={1.5} strokeDasharray="2 2" connectNulls />
              </LineChart>
            </ResponsiveContainer>
            <LatencyStatsTable
              stats={latencyStats}
              keys={['e2eP50', 'e2eP99', 'e2eP999']}
              labels={['P50', 'P99', 'P99.9']}
              warmupNote={isLive && currentSamples <= warmupSamples}
            />
          </ChartCard>
        </div>
      )}

      {/* Row 3: Prometheus data (only if available) */}
      {promPoints.length > 0 && (
        <div className="charts-row charts-row-2">
          <ChartCard title="Broker Bytes In/Out (MB/s)" badge="redpanda">
            <ResponsiveContainer width="100%" height={180}>
              <LineChart data={promPoints} syncId="run">
                <CartesianGrid strokeDasharray="3 3" stroke="#2a3045" />
                <XAxis dataKey="t" stroke="#7a8399" tick={{ fill: '#7a8399', fontSize: 10 }} />
                <YAxis stroke="#7a8399" tick={{ fill: '#7a8399', fontSize: 10 }} width={50} />
                <Tooltip contentStyle={{ background: '#171c28', border: '1px solid #2a3045', color: '#e8edf8', fontSize: 11 }} />
                <Legend wrapperStyle={{ fontSize: 11, color: '#7a8399' }} />
                <Line type="monotone" dataKey="bytesInMBSec"  name="bytes in"  stroke="#38bdf8" dot={false} strokeWidth={2} />
                <Line type="monotone" dataKey="bytesOutMBSec" name="bytes out" stroke="#7dd3fc" dot={false} strokeWidth={1.5} strokeDasharray="5 3" />
              </LineChart>
            </ResponsiveContainer>
          </ChartCard>

          <ChartCard title="Records / sec" badge="redpanda">
            <ResponsiveContainer width="100%" height={180}>
              <LineChart data={promPoints} syncId="run">
                <CartesianGrid strokeDasharray="3 3" stroke="#2a3045" />
                <XAxis dataKey="t" stroke="#7a8399" tick={{ fill: '#7a8399', fontSize: 10 }} />
                <YAxis stroke="#7a8399" tick={{ fill: '#7a8399', fontSize: 10 }} width={50} />
                <Tooltip contentStyle={{ background: '#171c28', border: '1px solid #2a3045', color: '#e8edf8', fontSize: 11 }} />
                <Line type="monotone" dataKey="recordsPerSec" name="records/sec" stroke="#a78bfa" dot={false} strokeWidth={2} />
              </LineChart>
            </ResponsiveContainer>
          </ChartCard>
        </div>
      )}
    </div>
  );
}
