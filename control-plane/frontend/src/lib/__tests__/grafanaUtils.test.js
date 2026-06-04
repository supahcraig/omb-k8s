import { describe, it, expect } from 'vitest'
import { buildGrafanaUrl, buildRunGrafanaUrl, buildSweepGrafanaUrl } from '../grafanaUtils.js'

const BASE = 'http://abc.elb.amazonaws.com'
const UID  = 'FejE4c6nz'

describe('buildGrafanaUrl', () => {
  it('builds relative time range', () => {
    const url = buildGrafanaUrl(BASE, 'now-6h', 'now')
    expect(url).toBe(`${BASE}/d/${UID}/redpanda-ops-dashboard?orgId=1&from=now-6h&to=now`)
  })

  it('builds absolute time range from ms timestamps', () => {
    const url = buildGrafanaUrl(BASE, 1000000000000, 1000003600000)
    expect(url).toBe(`${BASE}/d/${UID}/redpanda-ops-dashboard?orgId=1&from=1000000000000&to=1000003600000`)
  })

  it('builds absolute time range from Date objects', () => {
    const from = new Date('2026-06-02T10:00:00Z')
    const to   = new Date('2026-06-02T10:10:00Z')
    const url  = buildGrafanaUrl(BASE, from, to)
    expect(url).toContain(`from=${from.getTime()}`)
    expect(url).toContain(`to=${to.getTime()}`)
  })

  it('mixes relative and absolute', () => {
    const url = buildGrafanaUrl(BASE, 1000000000000, 'now')
    expect(url).toContain('from=1000000000000')
    expect(url).toContain('to=now')
  })

  it('always includes orgId=1', () => {
    expect(buildGrafanaUrl(BASE, 'now-6h', 'now')).toContain('orgId=1')
  })
})

describe('buildRunGrafanaUrl', () => {
  it('subtracts 1 minute from started_at and adds 1 minute to completed_at', () => {
    const started   = '2026-06-02T10:00:00'   // naive UTC from SQLite
    const completed = '2026-06-02T10:10:00'
    const url = buildRunGrafanaUrl(BASE, started, completed)
    const expectedFrom = new Date('2026-06-02T10:00:00Z').getTime() - 60000
    const expectedTo   = new Date('2026-06-02T10:10:00Z').getTime() + 60000
    expect(url).toContain(`from=${expectedFrom}`)
    expect(url).toContain(`to=${expectedTo}`)
  })

  it('uses to=now when completed_at is null (run still active)', () => {
    const url = buildRunGrafanaUrl(BASE, '2026-06-02T10:00:00', null)
    expect(url).toContain('to=now')
  })

  it('appends Z to naive datetime strings before parsing', () => {
    const url = buildRunGrafanaUrl(BASE, '2026-06-02T10:00:00', '2026-06-02T10:10:00')
    // if Z not appended, new Date() may parse as local time — test it produces a valid ms number
    const params = new URLSearchParams(url.split('?')[1])
    expect(Number(params.get('from'))).toBeGreaterThan(0)
    expect(Number(params.get('to'))).toBeGreaterThan(0)
  })
})

describe('buildSweepGrafanaUrl', () => {
  it('spans from first run start minus 1 min to last run end plus 1 min', () => {
    const runs = [
      { started_at: '2026-06-02T10:00:00', completed_at: '2026-06-02T10:10:00', status: 'completed' },
      { started_at: '2026-06-02T10:11:00', completed_at: '2026-06-02T10:21:00', status: 'completed' },
    ]
    const url = buildSweepGrafanaUrl(BASE, runs)
    const expectedFrom = new Date('2026-06-02T10:00:00Z').getTime() - 60000
    const expectedTo   = new Date('2026-06-02T10:21:00Z').getTime() + 60000
    expect(url).toContain(`from=${expectedFrom}`)
    expect(url).toContain(`to=${expectedTo}`)
  })

  it('uses to=now when any run is pending or running', () => {
    const runs = [
      { started_at: '2026-06-02T10:00:00', completed_at: '2026-06-02T10:10:00', status: 'completed' },
      { started_at: '2026-06-02T10:11:00', completed_at: null, status: 'running' },
    ]
    const url = buildSweepGrafanaUrl(BASE, runs)
    expect(url).toContain('to=now')
  })

  it('returns null when runs array is empty', () => {
    expect(buildSweepGrafanaUrl(BASE, [])).toBeNull()
  })

  it('returns null when first run has no started_at', () => {
    expect(buildSweepGrafanaUrl(BASE, [{ started_at: null, status: 'pending' }])).toBeNull()
  })
})
