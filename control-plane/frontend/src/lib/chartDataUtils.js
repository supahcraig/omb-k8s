export function normalizeTimeseries(metricsOut, messageSize) {
  if (!metricsOut) return [];

  let pub = [], cons = [], backlog = [];
  try {
    const t = JSON.parse(metricsOut.throughput_timeseries || '{}');
    pub  = t.publish_rate  || [];
    cons = t.consume_rate  || [];
  } catch { /* ignore parse errors */ }
  try {
    const b = JSON.parse(metricsOut.backlog_timeseries || '{}');
    backlog = b.backlog || [];
  } catch { /* ignore parse errors */ }

  const len = Math.min(pub.length, cons.length, backlog.length);
  const mbFactor = messageSize / 1_048_576;

  return Array.from({ length: len }, (_, i) => ({
    t:          i,
    pubMsgSec:  pub[i],
    consMsgSec: cons[i],
    pubMBSec:   pub[i]  * mbFactor,
    consMBSec:  cons[i] * mbFactor,
    backlog:    backlog[i],
    pubP50:     null,
    pubP99:     null,
    pubP999:    null,
    e2eP50:     null,
    e2eP99:     null,
    e2eP999:    null,
  }));
}

export function computeLatencyStats(points, warmupSamples = 0) {
  const sample = points.slice(warmupSamples);
  if (sample.length === 0) return null;

  function stats(key) {
    const vals = sample.map(p => p[key]).filter(v => v != null);
    if (vals.length === 0) return null;
    const mean = vals.reduce((a, b) => a + b, 0) / vals.length;
    return { min: Math.min(...vals), mean, max: Math.max(...vals) };
  }

  return {
    pubP50:  stats('pubP50'),
    pubP99:  stats('pubP99'),
    pubP999: stats('pubP999'),
    e2eP50:  stats('e2eP50'),
    e2eP99:  stats('e2eP99'),
    e2eP999: stats('e2eP999'),
  };
}

export function promToChartData(samples) {
  return samples.map(s => {
    const memPerPod = s.worker_memory_per_pod
      ? JSON.parse(s.worker_memory_per_pod)
      : {};
    const cpuPerPod = s.worker_cpu_per_pod
      ? JSON.parse(s.worker_cpu_per_pod)
      : {};

    const point = {
      t:                 s.t,
      bytesInMBSec:      s.bytes_in_per_sec  != null ? s.bytes_in_per_sec  / 1_048_576 : null,
      bytesOutMBSec:     s.bytes_out_per_sec != null ? s.bytes_out_per_sec / 1_048_576 : null,
      recordsPerSec:     s.records_per_sec,
      workerCpuPct:      s.worker_cpu_pct,
      workerMemMiB:      s.worker_memory_mib,
      workerThrottlePct: s.worker_throttle_pct,
    };

    for (const [pod, val] of Object.entries(memPerPod)) {
      point[`workerMem_${pod}`] = val;
    }
    for (const [pod, val] of Object.entries(cpuPerPod)) {
      point[`workerCpu_${pod}`] = val;
    }

    return point;
  });
}
