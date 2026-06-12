import { useEffect, useRef, useState } from 'react'
import { listPods, getPodLogs, restartPod, listWorkerPools, releaseWorkerPool } from '../api.js'

const GROUPS = [
  { label: 'Control Plane',  match: n => n.startsWith('omb-control-plane') },
  { label: 'Workers',        match: n => /^omb-worker-\d/.test(n) },
  { label: 'Runners',        match: n => n.startsWith('omb-run-') },
  { label: 'Infrastructure', match: () => true },
]

function groupPods(pods) {
  const buckets = GROUPS.map(g => ({ label: g.label, pods: [] }))
  for (const pod of pods) {
    const idx = GROUPS.findIndex(g => g.match(pod.name))
    buckets[idx === -1 ? buckets.length - 1 : idx].pods.push(pod)
  }
  return buckets.filter(b => b.pods.length > 0)
}

const PHASE_BADGE = {
  Running:   'running',
  Pending:   'pending',
  Succeeded: 'completed',
  Failed:    'failed',
  Unknown:   'pending',
}

const TAIL_OPTIONS = [100, 500, 1000, 2000]

function WorkerHealthDot({ healthy }) {
  if (healthy === null || healthy === undefined) return null
  return (
    <span
      title={healthy ? 'Worker HTTP reachable' : 'Worker HTTP unreachable — may be stuck'}
      style={{
        display: 'inline-block',
        width: 8,
        height: 8,
        borderRadius: '50%',
        background: healthy ? '#4ade80' : '#ef4444',
        marginRight: 6,
        flexShrink: 0,
        cursor: 'help',
      }}
    />
  )
}

const POOL_STATUS_BADGE = {
  ready:        'completed',
  in_use:       'running',
  provisioning: 'pending',
  tearing_down: 'pending',
  deleted:      'failed',
}

function useNow(active) {
  const [now, setNow] = useState(Date.now())
  useEffect(() => {
    if (!active) return
    const id = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(id)
  }, [active])
  return now
}

function fmtCountdown(warmUntilStr, nowMs) {
  if (!warmUntilStr) return null
  const until = new Date(warmUntilStr.endsWith('Z') ? warmUntilStr : warmUntilStr + 'Z').getTime()
  const remaining = Math.max(0, Math.floor((until - nowMs) / 1000))
  if (remaining === 0) return 'expiring…'
  const m = Math.floor(remaining / 60)
  const s = remaining % 60
  return `${m}:${String(s).padStart(2, '0')}`
}

function WorkerPoolsTable({ pools, onRelease, releasing }) {
  const hasWarm = pools.some(p => p.status === 'ready' && p.warm_until && p.id !== 'default')
  const now = useNow(hasWarm)

  if (!pools.length) return null
  return (
    <div className="card mt-20">
      <div className="card-header">
        <h3 style={{ margin: 0, fontSize: 14 }}>Worker Pools</h3>
      </div>
      <table className="data-table">
        <thead>
          <tr>
            <th>Pool ID</th>
            <th>StatefulSet</th>
            <th className="num">Replicas</th>
            <th>Status</th>
            <th>Claimed By</th>
            <th>Warm For</th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          {pools.map(pool => {
            const isDefault  = pool.id === 'default'
            const canRelease = !isDefault && pool.status !== 'in_use' && pool.status !== 'deleted'
            const countdown  = pool.status === 'ready' && pool.warm_until
              ? fmtCountdown(pool.warm_until, now)
              : null
            return (
              <tr key={pool.id}>
                <td style={{ fontFamily: 'monospace', fontSize: 12 }}>
                  {isDefault ? <span title="Pre-existing default worker StatefulSet">default</span> : pool.id}
                </td>
                <td style={{ fontFamily: 'monospace', fontSize: 12 }}>{pool.statefulset_name}</td>
                <td className="num">{pool.replicas}</td>
                <td>
                  <span className={`badge badge-${POOL_STATUS_BADGE[pool.status] || 'pending'}`}>
                    {pool.status}
                  </span>
                </td>
                <td className="text-muted text-small">
                  {pool.claimed_by_run_id ? (
                    <a href={`/runs/${pool.claimed_by_run_id}`} style={{ color: 'var(--color-accent)' }}>
                      Run #{pool.claimed_by_run_id}
                    </a>
                  ) : '—'}
                </td>
                <td className="text-muted text-small" style={{ fontFamily: 'monospace', fontSize: 12 }}>
                  {countdown
                    ? <span style={{ color: countdown === 'expiring…' ? '#ef4444' : '#f59e0b' }}>{countdown}</span>
                    : '—'}
                </td>
                <td style={{ textAlign: 'right', paddingRight: 8 }}>
                  {!isDefault && pool.status !== 'deleted' && (
                    <button
                      className="btn btn-secondary btn-sm"
                      onClick={() => onRelease(pool.id)}
                      disabled={!canRelease || releasing === pool.id}
                      title={
                        pool.status === 'in_use'
                          ? 'Cannot release while a run is active'
                          : 'Release pool and tear down StatefulSet'
                      }
                    >
                      {releasing === pool.id ? '…' : 'Release'}
                    </button>
                  )}
                </td>
              </tr>
            )
          })}
        </tbody>
      </table>
    </div>
  )
}

export default function ClusterPage() {
  const [namespace, setNamespace]           = useState('')
  const [pods, setPods]                     = useState([])
  const [podsLoading, setPodsLoading]       = useState(true)
  const [podsError, setPodsError]           = useState(null)
  const [restartingPod, setRestartingPod]   = useState(null)
  const [selectedPod, setSelectedPod]       = useState(null)
  const [selectedContainer, setSelectedContainer] = useState('')
  const [tailLines, setTailLines]           = useState(500)
  const [logs, setLogs]                     = useState(null)
  const [logsLoading, setLogsLoading]       = useState(false)
  const [logsError, setLogsError]           = useState(null)
  const logEndRef = useRef(null)

  const [pools, setPools]           = useState([])
  const [poolsLoading, setPoolsLoading] = useState(false)
  const [releasingPool, setReleasingPool] = useState(null)

  async function fetchPools() {
    setPoolsLoading(true)
    try {
      const data = await listWorkerPools()
      setPools(data)
    } catch (_) {
      // pools section is optional; don't error the whole page
    } finally {
      setPoolsLoading(false)
    }
  }

  async function handleReleasePool(poolId) {
    if (!confirm(`Release pool ${poolId}? This will delete its StatefulSet and Service immediately.`)) return
    setReleasingPool(poolId)
    try {
      await releaseWorkerPool(poolId)
      await fetchPools()
    } catch (err) {
      alert(`Failed to release pool ${poolId}: ${err.message}`)
    } finally {
      setReleasingPool(null)
    }
  }

  async function fetchPods() {
    setPodsLoading(true)
    setPodsError(null)
    try {
      const data = await listPods()
      setNamespace(data.namespace)
      setPods(data.pods)
    } catch (e) {
      setPodsError(e.message)
    } finally {
      setPodsLoading(false)
    }
  }

  async function fetchLogs(podName, container, tail) {
    setLogsLoading(true)
    setLogsError(null)
    setLogs(null)
    try {
      const data = await getPodLogs(podName, container, tail)
      setLogs(data.lines)
    } catch (e) {
      setLogsError(e.message)
    } finally {
      setLogsLoading(false)
    }
  }

  useEffect(() => { fetchPods(); fetchPools() }, [])

  useEffect(() => {
    if (logs !== null) logEndRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [logs])

  function selectPod(pod) {
    setSelectedPod(pod)
    const container = pod.containers[0] || ''
    setSelectedContainer(container)
    fetchLogs(pod.name, container, tailLines)
  }

  async function handleRestart(e, podName) {
    e.stopPropagation()
    if (!confirm(`Restart pod ${podName}? It will be deleted and recreated by its controller.`)) return
    setRestartingPod(podName)
    try {
      await restartPod(podName)
      await new Promise(r => setTimeout(r, 1500))
      await fetchPods()
    } catch (err) {
      alert(`Failed to restart ${podName}: ${err.message}`)
    } finally {
      setRestartingPod(null)
    }
  }

  function handleContainerChange(e) {
    const c = e.target.value
    setSelectedContainer(c)
    fetchLogs(selectedPod.name, c, tailLines)
  }

  function handleTailChange(e) {
    const t = Number(e.target.value)
    setTailLines(t)
    fetchLogs(selectedPod.name, selectedContainer, t)
  }

  return (
    <div>
      <div className="page-header">
        <div>
          <h1 className="page-title">Cluster</h1>
          {namespace && <div className="text-muted text-small">namespace: {namespace}</div>}
        </div>
        <button className="btn btn-secondary" onClick={fetchPods} disabled={podsLoading}>
          {podsLoading ? 'Refreshing…' : 'Refresh'}
        </button>
      </div>

      {podsError && <div className="alert alert-error">{podsError}</div>}

      <div className="card">
        <table className="data-table">
          <thead>
            <tr>
              <th>Name</th>
              <th>Phase</th>
              <th>Ready</th>
              <th className="num">Restarts</th>
              <th>Age</th>
              <th>Node</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {podsLoading && pods.length === 0 ? (
              <tr><td colSpan={7} className="text-muted" style={{ textAlign: 'center', padding: '20px 0' }}>Loading pods…</td></tr>
            ) : pods.length === 0 ? (
              <tr><td colSpan={7} className="text-muted" style={{ textAlign: 'center', padding: '20px 0' }}>No pods found</td></tr>
            ) : groupPods(pods).map(group => (
              <>
                <tr key={`group-${group.label}`}>
                  <td colSpan={7} style={{
                    background: 'var(--color-surface)',
                    color: 'var(--color-text-muted)',
                    fontSize: 10,
                    fontWeight: 700,
                    letterSpacing: '0.08em',
                    textTransform: 'uppercase',
                    padding: '6px 12px',
                    borderTop: '1px solid var(--color-border)',
                  }}>
                    {group.label} <span style={{ fontWeight: 400, opacity: 0.6 }}>({group.pods.length})</span>
                  </td>
                </tr>
                {group.pods.map(pod => (
                  <tr
                    key={pod.name}
                    onClick={() => selectPod(pod)}
                    style={{
                      cursor: 'pointer',
                      background: selectedPod?.name === pod.name ? 'rgba(96,165,250,0.08)' : undefined,
                    }}
                  >
                    <td style={{ fontFamily: 'monospace', fontSize: 13 }}>
                      <div style={{ display: 'flex', alignItems: 'center' }}>
                        <WorkerHealthDot healthy={pod.worker_healthy} />
                        {pod.name}
                      </div>
                      {(pod.image_hash || pod.image_ref) && (
                        <div style={{ color: 'var(--color-text-muted)', fontSize: 10, marginTop: 1 }}>
                          {pod.image_hash ? `sha256:${pod.image_hash}` : pod.image_ref}
                        </div>
                      )}
                    </td>
                    <td><span className={`badge badge-${PHASE_BADGE[pod.phase] || 'pending'}`}>{pod.phase}</span></td>
                    <td>{pod.ready}</td>
                    <td className="num">{pod.restarts > 0 ? <span style={{ color: '#f59e0b' }}>{pod.restarts}</span> : pod.restarts}</td>
                    <td>{pod.age}</td>
                    <td className="text-muted text-small" style={{ fontFamily: 'monospace', fontSize: 11 }}>{pod.node}</td>
                    <td onClick={e => e.stopPropagation()} style={{ textAlign: 'right', paddingRight: 8 }}>
                      <button
                        className="btn btn-secondary btn-sm"
                        onClick={e => handleRestart(e, pod.name)}
                        disabled={restartingPod === pod.name}
                        title="Restart (delete + recreate)"
                      >
                        {restartingPod === pod.name ? '…' : '↺'}
                      </button>
                    </td>
                  </tr>
                ))}
              </>
            ))}
          </tbody>
        </table>
      </div>

      {!poolsLoading && pools.length > 0 && (
        <WorkerPoolsTable
          pools={pools}
          onRelease={handleReleasePool}
          releasing={releasingPool}
        />
      )}

      {selectedPod && (
        <div className="card mt-20">
          <div className="card-header">
            <h3 style={{ fontFamily: 'monospace' }}>{selectedPod.name}</h3>
            <div className="flex items-center gap-8">
              {selectedPod.containers.length > 1 && (
                <select
                  value={selectedContainer}
                  onChange={handleContainerChange}
                  style={{ background: 'var(--color-surface)', color: 'var(--color-text)', border: '1px solid var(--color-border)', borderRadius: 4, padding: '2px 6px', fontSize: 12 }}
                >
                  {selectedPod.containers.map(c => <option key={c} value={c}>{c}</option>)}
                </select>
              )}
              <select
                value={tailLines}
                onChange={handleTailChange}
                style={{ background: 'var(--color-surface)', color: 'var(--color-text)', border: '1px solid var(--color-border)', borderRadius: 4, padding: '2px 6px', fontSize: 12 }}
              >
                {TAIL_OPTIONS.map(n => <option key={n} value={n}>{n} lines</option>)}
              </select>
              <button
                className="btn btn-secondary btn-sm"
                onClick={() => fetchLogs(selectedPod.name, selectedContainer, tailLines)}
                disabled={logsLoading}
              >
                {logsLoading ? 'Loading…' : 'Refresh'}
              </button>
            </div>
          </div>
          <div className="card-body" style={{ padding: 0 }}>
            {logsError && (
              <div className="alert alert-error" style={{ margin: '12px 16px' }}>{logsError}</div>
            )}
            <div className="log-viewer">
              {logsLoading
                ? 'Loading logs…'
                : logs === null
                  ? ''
                  : logs.length === 0
                    ? '(no log output)'
                    : logs.join('\n')}
              <div ref={logEndRef} />
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
