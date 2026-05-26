import React from 'react';
import {
  LineChart, Line, XAxis, YAxis, CartesianGrid,
  Tooltip, Legend, ResponsiveContainer,
} from 'recharts';
import { normalizeTimeseries, promToChartData } from '../lib/chartDataUtils.js';

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

export default function RunCharts({ livePoints = [], metricsOut = null, promSamples = [], isLive = false, messageSize = 1024 }) {
  const chartPoints = isLive || !metricsOut ? livePoints : normalizeTimeseries(metricsOut, messageSize);
  const promPoints  = promToChartData(promSamples);
  const hasLatency  = chartPoints.some(p => p.pubP99 != null);

  if (chartPoints.length === 0 && promPoints.length === 0) return null;

  return (
    <div className="run-charts">
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
          <ChartCard title="Publish Latency P99 (ms)" badge="omb">
            <ResponsiveContainer width="100%" height={180}>
              <LineChart data={chartPoints} syncId="run">
                <CartesianGrid strokeDasharray="3 3" stroke="#2a3045" />
                <XAxis dataKey="t" stroke="#7a8399" tick={{ fill: '#7a8399', fontSize: 10 }} />
                <YAxis stroke="#7a8399" tick={{ fill: '#7a8399', fontSize: 10 }} width={50} />
                <Tooltip contentStyle={{ background: '#171c28', border: '1px solid #2a3045', color: '#e8edf8', fontSize: 11 }} />
                <Line type="monotone" dataKey="pubP99" name="p99" stroke="#f59e0b" dot={false} strokeWidth={2} />
              </LineChart>
            </ResponsiveContainer>
          </ChartCard>

          <ChartCard title="E2E Latency P99 (ms)" badge="omb">
            <ResponsiveContainer width="100%" height={180}>
              <LineChart data={chartPoints} syncId="run">
                <CartesianGrid strokeDasharray="3 3" stroke="#2a3045" />
                <XAxis dataKey="t" stroke="#7a8399" tick={{ fill: '#7a8399', fontSize: 10 }} />
                <YAxis stroke="#7a8399" tick={{ fill: '#7a8399', fontSize: 10 }} width={50} />
                <Tooltip contentStyle={{ background: '#171c28', border: '1px solid #2a3045', color: '#e8edf8', fontSize: 11 }} />
                <Line type="monotone" dataKey="e2eP99" name="p99" stroke="#fcd34d" dot={false} strokeWidth={2} />
              </LineChart>
            </ResponsiveContainer>
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
