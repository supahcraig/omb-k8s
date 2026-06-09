const BASE = '/api'

async function request(method, path, body) {
  const opts = { method, headers: {} }
  if (body !== undefined) {
    opts.headers['Content-Type'] = 'application/json'
    opts.body = JSON.stringify(body)
  }
  const res = await fetch(`${BASE}${path}`, opts)
  if (res.status === 204) return null
  if (!res.ok) {
    const text = await res.text()
    let message = text
    try { message = JSON.parse(text).detail || text } catch { /* use raw text */ }
    const err = new Error(message)
    err.status = res.status
    throw err
  }
  return res.json()
}

// Workers
export const getWorkerStatus = () => request('GET', '/workers/status')
export const scaleWorkers = (replicas) => request('POST', '/workers/scale', { replicas })
export const getWorkerResources = () => request('GET', '/workers/resources')

// Settings
export const getSettings = () => request('GET', '/settings')
export const updateSettings = (body) => request('PUT', '/settings', body)
export const testConnection = () => request('POST', '/settings/test-connection')

// Workloads
export const listWorkloads = () => request('GET', '/workloads')
export const createWorkload = (body) => request('POST', '/workloads', body)
export const updateWorkload = (id, body) => request('PUT', `/workloads/${id}`, body)
export const deleteWorkload = (id) => request('DELETE', `/workloads/${id}`)

// Drivers
export const listDrivers = () => request('GET', '/drivers')
export const createDriver = (body) => request('POST', '/drivers', body)
export const updateDriver = (id, body) => request('PUT', `/drivers/${id}`, body)
export const deleteDriver = (id) => request('DELETE', `/drivers/${id}`)

// Runs
export const listRuns = () => request('GET', '/runs')
export const getRun = (id) => request('GET', `/runs/${id}`)
export const createRun = (body) => request('POST', '/runs', body)
export const cancelRun = (id) => request('DELETE', `/runs/${id}`)
export const getRunResults = (runId) => request('GET', `/runs/${runId}/results`)

// Sweeps
export const listSweeps = () => request('GET', '/sweeps')
export const getSweep = (id) => request('GET', `/sweeps/${id}`)
export const getSweepRuns = (id) => request('GET', `/sweeps/${id}/runs`)
export const createSweep = (body) => request('POST', '/sweeps', body)
export const cancelSweep = (id) => request('DELETE', `/sweeps/${id}`)
export const getSweepVisualizationData = (id) => request('GET', `/sweeps/${id}/visualization-data`)

// Prometheus samples
export const getPrometheusSamples = (runId) => request('GET', `/prometheus/runs/${runId}`)

// Cluster / k8s
export const listPods    = ()                              => request('GET', '/cluster/pods')
export const restartPod  = (name)                         => request('DELETE', `/cluster/pods/${encodeURIComponent(name)}`)
export const getPodLogs  = (name, container, tail = 500)  => {
  const params = new URLSearchParams({ tail })
  if (container) params.set('container', container)
  return request('GET', `/cluster/pods/${encodeURIComponent(name)}/logs?${params}`)
}

// Grafana
export const getGrafanaUrl = () => request('GET', '/grafana/url')
