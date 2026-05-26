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

// Settings
export const getSettings = () => request('GET', '/settings')
export const updateSettings = (body) => request('PUT', '/settings', body)
export const testConnection = () => request('POST', '/settings/test-connection')

// Workloads
export const listWorkloads = () => request('GET', '/workloads')
export const createWorkload = (body) => request('POST', '/workloads', body)
export const updateWorkload = (id, body) => request('PUT', `/workloads/${id}`, body)
export const deleteWorkload = (id) => request('DELETE', `/workloads/${id}`)

// Runs
export const listRuns = () => request('GET', '/runs')
export const getRun = (id) => request('GET', `/runs/${id}`)
export const createRun = (body) => request('POST', '/runs', body)
export const cancelRun = (id) => request('DELETE', `/runs/${id}`)

// Sweeps
export const listSweeps = () => request('GET', '/sweeps')
export const getSweep = (id) => request('GET', `/sweeps/${id}`)
export const getSweepRuns = (id) => request('GET', `/sweeps/${id}/runs`)
export const createSweep = (body) => request('POST', '/sweeps', body)
export const cancelSweep = (id) => request('DELETE', `/sweeps/${id}`)

// Prometheus samples
export const getPrometheusSamples = (runId) => request('GET', `/prometheus/runs/${runId}`)
