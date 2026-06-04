const DASHBOARD_UID  = 'FejE4c6nz'
const DASHBOARD_SLUG = 'redpanda-ops-dashboard'

function toMs(val) {
  if (typeof val === 'string' && isNaN(Number(val))) return val  // relative like 'now-6h'
  if (val instanceof Date) return val.getTime()
  return val  // already ms number
}

export function buildGrafanaUrl(baseUrl, from, to) {
  const f = toMs(from)
  const t = toMs(to)
  return `${baseUrl}/d/${DASHBOARD_UID}/${DASHBOARD_SLUG}?orgId=1&from=${f}&to=${t}`
}

function parseTs(datetimeStr) {
  if (!datetimeStr) return null
  const s = datetimeStr.endsWith('Z') ? datetimeStr : datetimeStr + 'Z'
  return new Date(s).getTime()
}

export function buildRunGrafanaUrl(baseUrl, startedAt, completedAt) {
  const from = parseTs(startedAt) - 60000
  const to   = completedAt ? parseTs(completedAt) + 60000 : 'now'
  return buildGrafanaUrl(baseUrl, from, to)
}

export function buildSweepGrafanaUrl(baseUrl, runs) {
  if (!runs?.length) return null
  const first = runs[0]
  if (!first.started_at) return null

  const hasActive = runs.some(r => r.status === 'running' || r.status === 'pending')
  const lastCompleted = [...runs].reverse().find(r => r.completed_at)

  const from = parseTs(first.started_at) - 60000
  const to   = hasActive || !lastCompleted ? 'now' : parseTs(lastCompleted.completed_at) + 60000
  return buildGrafanaUrl(baseUrl, from, to)
}
