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
    pubP99:     null,
    e2eP99:     null,
  }));
}

export function promToChartData(samples) {
  return samples.map((s, i) => ({
    t:             i,
    bytesInMBSec:  s.bytes_in_per_sec  / 1_048_576,
    bytesOutMBSec: s.bytes_out_per_sec / 1_048_576,
    recordsPerSec: s.records_per_sec,
  }));
}
