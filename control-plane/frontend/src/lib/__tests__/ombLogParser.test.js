import { parseLiveMetric, parseE2ELatency } from '../ombLogParser.js';

describe('parseLiveMetric', () => {
  const fullLine = '16:23:18.626 [main] INFO - Pub rate 98412.300 msg/s / 96.100 MB/s | Cons rate 97881.200 msg/s / 95.600 MB/s | Backlog: 0 K | Pub Latency (ms) avg: 8.200 - 50%: 7.400 - 99%: 15.200 - 99.9%: 22.400 - Max: 25.000 | E2E Latency (ms) avg: 11.300 - 50%: 10.100 - 99%: 18.600 - 99.9%: 28.100 - Max: 30.000';

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
    const line = 'Pub rate 1,234,567.8 msg/s / 1,200.0 MB/s | Cons rate 1,234,000.0 msg/s / 1,199.5 MB/s | Backlog: 100 K';
    const result = parseLiveMetric(line, 1);
    expect(result.pubMsgSec).toBeCloseTo(1234567.8);
    expect(result.backlog).toBeCloseTo(100);
  });

  test('returns null pubP99 and e2eP99 when latency section absent', () => {
    const line = 'Pub rate 50000.0 msg/s / 50.0 MB/s | Cons rate 49900.0 msg/s / 49.9 MB/s | Backlog: 5 K';
    const result = parseLiveMetric(line, 2);
    expect(result).not.toBeNull();
    expect(result.pubP99).toBeNull();
    expect(result.e2eP99).toBeNull();
  });

  test('parses negative backlog', () => {
    const line = 'Pub rate 70392.744 msg/s / 68.743 MB/s | Cons rate 71637.670 msg/s / 69.958 MB/s | Backlog: -13.104 K';
    const result = parseLiveMetric(line, 3);
    expect(result).not.toBeNull();
    expect(result.backlog).toBeCloseTo(-13.104);
  });
});

describe('parseE2ELatency', () => {
  test('parses e2e p99 from standalone E2E line', () => {
    const line = '16:23:18.636 [main] INFO - E2E Latency (ms) avg: 784.594 - 50%: 677.119 - 99%: 2982.287 - 99.9%: 3684.543 - Max: 4135.519';
    expect(parseE2ELatency(line)).toBeCloseTo(2982.287);
  });

  test('returns null for non-E2E line', () => {
    expect(parseE2ELatency('Starting benchmark...')).toBeNull();
    expect(parseE2ELatency('')).toBeNull();
  });
});
