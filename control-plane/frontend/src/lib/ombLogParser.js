// Per-second stat line:
// Pub rate 12345 msg/s / 11.77 MB/s | Cons rate ... | Backlog: 0.0 K |
//   Pub Latency (ms) avg: X - 50%: X - 99%: X - 99.9%: X - Max: X |
//   Pub Delay Latency (us) avg: X - 50%: X - 99%: X - 99.9%: X - Max: X
const PUB_RE      = /Pub rate\s+([\d,.]+)\s*msg\/s\s*\/\s*([\d,.]+)\s*MB\/s/;
const CONS_RE     = /Cons rate\s+([\d,.]+)\s*msg\/s\s*\/\s*([\d,.]+)\s*MB\/s/;
const BACK_RE     = /Backlog:\s*(-?[\d,.]+)/;
const PUB_P50_RE  = /Pub Latency[^|]*?50%:\s*([\d,.]+)/;
const PUB_P99_RE  = /Pub Latency[^|]*?99%:\s*([\d,.]+)/;
const PUB_P999_RE = /Pub Latency[^|]*?99\.9%:\s*([\d,.]+)/;
// Pub Delay Latency is in microseconds — used as live E2E proxy
const DELAY_P50_RE  = /Pub Delay Latency[^|]*?50%:\s*([\d,.]+)/;
const DELAY_P99_RE  = /Pub Delay Latency[^|]*?99%:\s*([\d,.]+)/;
const DELAY_P999_RE = /Pub Delay Latency[^|]*?99\.9%:\s*([\d,.]+)/;

// Separate E2E Latency line (logged after each per-second stat):
// E2E Latency (ms) avg: X - 50%: X - 99%: X - 99.9%: X - Max: X
const E2E_P50_RE  = /50%:\s*([\d,.]+)/;
const E2E_P99_RE  = /E2E Latency[^|]*?99%:\s*([\d,.]+)/;
const E2E_P999_RE = /99\.9%:\s*([\d,.]+)/;

const num = s => parseFloat(s.replace(/,/g, ''));
const usToMs = s => num(s) / 1000;

export function parseLiveMetric(line, sampleIndex) {
  const pubMatch  = PUB_RE.exec(line);
  const consMatch = CONS_RE.exec(line);
  const backMatch = BACK_RE.exec(line);

  if (!pubMatch || !consMatch || !backMatch) return null;

  const pubP50Match   = PUB_P50_RE.exec(line);
  const pubP99Match   = PUB_P99_RE.exec(line);
  const pubP999Match  = PUB_P999_RE.exec(line);
  const delayP50Match  = DELAY_P50_RE.exec(line);
  const delayP99Match  = DELAY_P99_RE.exec(line);
  const delayP999Match = DELAY_P999_RE.exec(line);

  return {
    t:          sampleIndex,
    pubMsgSec:  num(pubMatch[1]),
    pubMBSec:   num(pubMatch[2]),
    consMsgSec: num(consMatch[1]),
    consMBSec:  num(consMatch[2]),
    backlog:    num(backMatch[1]) * 1000,
    pubP50:     pubP50Match   ? num(pubP50Match[1])   : null,
    pubP99:     pubP99Match   ? num(pubP99Match[1])   : null,
    pubP999:    pubP999Match  ? num(pubP999Match[1])  : null,
    // Use Pub Delay Latency (us→ms) as live E2E proxy until the E2E line arrives
    e2eP50:     delayP50Match  ? usToMs(delayP50Match[1])  : null,
    e2eP99:     delayP99Match  ? usToMs(delayP99Match[1])  : null,
    e2eP999:    delayP999Match ? usToMs(delayP999Match[1]) : null,
  };
}

export function parseE2ELatency(line) {
  if (!line.includes('E2E Latency')) return null;
  const p50m  = E2E_P50_RE.exec(line);
  const p99m  = E2E_P99_RE.exec(line);
  const p999m = E2E_P999_RE.exec(line);
  if (!p50m && !p99m && !p999m) return null;
  return {
    e2eP50:  p50m  ? num(p50m[1])  : null,
    e2eP99:  p99m  ? num(p99m[1])  : null,
    e2eP999: p999m ? num(p999m[1]) : null,
  };
}
