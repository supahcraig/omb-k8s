import { parseLiveMetric } from '../ombLogParser.js';

describe('parseLiveMetric', () => {
  const fullLine = 'Pub rate: 98,412.3 msg/s / 96.1 MB/s | Cons rate: 97,881.2 msg/s / 95.6 MB/s | Backlog: 0 K msgs | Pub Latency (ms) avg:  8.2 - 50%:  7.4 - 99%: 15.2 - 99.9%: 22.4 | E2E Latency (ms) avg: 11.3 - 50%: 10.1 - 99%: 18.6 - 99.9%: 28.1';

  test('parses publish rate', () => {
    const result = parseLiveMetric(fullLine, 5);
    expect(result.pubMsgSec).toBeCloseTo(98412.3);
  });

  test('parses consume rate', () => {
    const result = parseLiveMetric(fullLine, 5);
    expect(result.consMsgSec).toBeCloseTo(97881.2);
  });

  test('parses MB/s values', () => {
    const result = parseLiveMetric(fullLine, 5);
    expect(result.pubMBSec).toBeCloseTo(96.1);
    expect(result.consMBSec).toBeCloseTo(95.6);
  });

  test('parses backlog (0 K)', () => {
    const result = parseLiveMetric(fullLine, 5);
    expect(result.backlog).toBe(0);
  });

  test('parses pub and e2e p99 latency', () => {
    const result = parseLiveMetric(fullLine, 5);
    expect(result.pubP99).toBeCloseTo(15.2);
    expect(result.e2eP99).toBeCloseTo(18.6);
  });

  test('sets t to sampleIndex', () => {
    const result = parseLiveMetric(fullLine, 7);
    expect(result.t).toBe(7);
  });

  test('returns null for non-matching line', () => {
    expect(parseLiveMetric('Starting benchmark...', 0)).toBeNull();
    expect(parseLiveMetric('', 0)).toBeNull();
  });

  test('handles line with commas in numbers', () => {
    const line = 'Pub rate: 1,234,567.8 msg/s / 1,200.0 MB/s | Cons rate: 1,234,000.0 msg/s / 1,199.5 MB/s | Backlog: 100 K msgs';
    const result = parseLiveMetric(line, 1);
    expect(result.pubMsgSec).toBeCloseTo(1234567.8);
    expect(result.backlog).toBeCloseTo(100);
  });

  test('returns null pubP99 and e2eP99 when latency section absent', () => {
    const line = 'Pub rate: 50,000.0 msg/s / 50.0 MB/s | Cons rate: 49,900.0 msg/s / 49.9 MB/s | Backlog: 5 K msgs';
    const result = parseLiveMetric(line, 2);
    expect(result).not.toBeNull();
    expect(result.pubP99).toBeNull();
    expect(result.e2eP99).toBeNull();
  });
});
