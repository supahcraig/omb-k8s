import { normalizeTimeseries, promToChartData, computeLatencyStats } from '../chartDataUtils.js';

describe('normalizeTimeseries', () => {
  const metricsOut = {
    throughput_timeseries: JSON.stringify({
      publish_rate: [100000, 99500, 98000],
      consume_rate: [99800, 99200, 97500],
      sample_rate_ms: 1000,
    }),
    backlog_timeseries: JSON.stringify({
      backlog: [0, 5, 10],
      sample_rate_ms: 1000,
    }),
  };

  test('returns one point per sample', () => {
    const result = normalizeTimeseries(metricsOut, 1024);
    expect(result).toHaveLength(3);
  });

  test('t is sample index (0-based)', () => {
    const result = normalizeTimeseries(metricsOut, 1024);
    expect(result[0].t).toBe(0);
    expect(result[1].t).toBe(1);
    expect(result[2].t).toBe(2);
  });

  test('pubMsgSec and consMsgSec match publish_rate and consume_rate arrays', () => {
    const result = normalizeTimeseries(metricsOut, 1024);
    expect(result[0].pubMsgSec).toBe(100000);
    expect(result[0].consMsgSec).toBe(99800);
  });

  test('pubMBSec computed from pubMsgSec * messageSize / 1048576', () => {
    const result = normalizeTimeseries(metricsOut, 1024);
    // 100000 * 1024 / 1048576 ≈ 97.656...
    expect(result[0].pubMBSec).toBeCloseTo(100000 * 1024 / 1048576);
  });

  test('consMBSec computed from consMsgSec * messageSize / 1048576', () => {
    const result = normalizeTimeseries(metricsOut, 1024);
    expect(result[0].consMBSec).toBeCloseTo(99800 * 1024 / 1048576);
  });

  test('backlog values from backlog_timeseries', () => {
    const result = normalizeTimeseries(metricsOut, 1024);
    expect(result[0].backlog).toBe(0);
    expect(result[1].backlog).toBe(5);
    expect(result[2].backlog).toBe(10);
  });

  test('pubP99 and e2eP99 are always null (not in stored timeseries)', () => {
    const result = normalizeTimeseries(metricsOut, 1024);
    expect(result[0].pubP50).toBeNull();
    expect(result[0].pubP99).toBeNull();
    expect(result[0].pubP999).toBeNull();
    expect(result[0].e2eP50).toBeNull();
    expect(result[0].e2eP99).toBeNull();
    expect(result[0].e2eP999).toBeNull();
  });

  test('returns empty array when metricsOut is null', () => {
    expect(normalizeTimeseries(null, 1024)).toEqual([]);
  });

  test('handles mismatched array lengths gracefully (uses shorter)', () => {
    const m = {
      throughput_timeseries: JSON.stringify({ publish_rate: [1, 2, 3, 4], consume_rate: [1, 2], sample_rate_ms: 1000 }),
      backlog_timeseries: JSON.stringify({ backlog: [0, 0, 0], sample_rate_ms: 1000 }),
    };
    const result = normalizeTimeseries(m, 1024);
    expect(result.length).toBeGreaterThan(0);
    expect(result.length).toBeLessThanOrEqual(4);
  });
});

describe('promToChartData', () => {
  const samples = [
    { t: 1716700000, bytes_in_per_sec: 100663296, bytes_out_per_sec: 99614720, records_per_sec: 98304 },
    { t: 1716700060, bytes_in_per_sec: 101711872, bytes_out_per_sec: 100663296, records_per_sec: 99000 },
  ];

  test('returns one point per sample', () => {
    expect(promToChartData(samples)).toHaveLength(2);
  });

  test('bytesInMBSec = bytes_in_per_sec / 1048576', () => {
    const result = promToChartData(samples);
    expect(result[0].bytesInMBSec).toBeCloseTo(100663296 / 1048576);
  });

  test('bytesOutMBSec = bytes_out_per_sec / 1048576', () => {
    const result = promToChartData(samples);
    expect(result[0].bytesOutMBSec).toBeCloseTo(99614720 / 1048576);
  });

  test('recordsPerSec passes through unchanged', () => {
    const result = promToChartData(samples);
    expect(result[0].recordsPerSec).toBe(98304);
  });

  test('t is 0-based index, not Unix timestamp', () => {
    const result = promToChartData(samples);
    expect(result[0].t).toBe(0);
    expect(result[1].t).toBe(1);
  });

  test('returns empty array for empty input', () => {
    expect(promToChartData([])).toEqual([]);
  });
});

describe('computeLatencyStats', () => {
  const makePoint = (t, pubP50, pubP99, pubP999, e2eP50, e2eP99, e2eP999) => ({
    t, pubMsgSec: 1, consMsgSec: 1, pubMBSec: 1, consMBSec: 1, backlog: 0,
    pubP50, pubP99, pubP999, e2eP50, e2eP99, e2eP999,
  });

  const points = [
    makePoint(0, 5,  10, 20, 8,  15, 25),  // warmup sample
    makePoint(1, 6,  12, 22, 9,  16, 26),
    makePoint(2, 7,  14, 24, 10, 17, 27),
    makePoint(3, 8,  16, 26, 11, 18, 28),
  ];

  test('returns null when no non-warmup points', () => {
    expect(computeLatencyStats(points, 4)).toBeNull();
  });

  test('excludes warmup samples from stats', () => {
    const stats = computeLatencyStats(points, 1);
    expect(stats.pubP50.min).toBe(6);
    expect(stats.pubP50.max).toBe(8);
    expect(stats.pubP50.mean).toBeCloseTo(7);
  });

  test('computes correct min/mean/max for pubP99', () => {
    const stats = computeLatencyStats(points, 1);
    expect(stats.pubP99.min).toBe(12);
    expect(stats.pubP99.max).toBe(16);
    expect(stats.pubP99.mean).toBeCloseTo(14);
  });

  test('computes e2e stats correctly', () => {
    const stats = computeLatencyStats(points, 1);
    expect(stats.e2eP99.min).toBe(16);
    expect(stats.e2eP99.max).toBe(18);
  });

  test('returns null for a stat key when all values are null', () => {
    const nullPoints = [
      makePoint(0, null, null, null, null, null, null),
      makePoint(1, null, null, null, null, null, null),
    ];
    const stats = computeLatencyStats(nullPoints, 0);
    expect(stats.pubP50).toBeNull();
  });

  test('warmupSamples defaults to 0 (no exclusion)', () => {
    const stats = computeLatencyStats(points);
    expect(stats.pubP50.min).toBe(5);
  });
});
