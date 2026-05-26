const PUB_RE    = /Pub rate:\s*([\d,.]+)\s*msg\/s\s*\/\s*([\d,.]+)\s*MB\/s/;
const CONS_RE   = /Cons rate:\s*([\d,.]+)\s*msg\/s\s*\/\s*([\d,.]+)\s*MB\/s/;
const BACK_RE   = /Backlog:\s*([\d,.]+)/;
const PUB_P99_RE = /Pub Latency[^|]*?99%:\s*([\d,.]+)/;
const E2E_P99_RE = /E2E Latency[^|]*?99%:\s*([\d,.]+)/;

const num = s => parseFloat(s.replace(/,/g, ''));

export function parseLiveMetric(line, sampleIndex) {
  const pubMatch  = PUB_RE.exec(line);
  const consMatch = CONS_RE.exec(line);
  const backMatch = BACK_RE.exec(line);

  if (!pubMatch || !consMatch || !backMatch) return null;

  const pubP99Match = PUB_P99_RE.exec(line);
  const e2eP99Match = E2E_P99_RE.exec(line);

  return {
    t:          sampleIndex,
    pubMsgSec:  num(pubMatch[1]),
    pubMBSec:   num(pubMatch[2]),
    consMsgSec: num(consMatch[1]),
    consMBSec:  num(consMatch[2]),
    backlog:    num(backMatch[1]),
    pubP99:     pubP99Match ? num(pubP99Match[1]) : null,
    e2eP99:     e2eP99Match ? num(e2eP99Match[1]) : null,
  };
}
