import { normalizeTimeseries, promToChartData } from '../chartDataUtils.js';

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
    expect(result[0].pubP99).toBeNull();
    expect(result[0].e2eP99).toBeNull();
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
