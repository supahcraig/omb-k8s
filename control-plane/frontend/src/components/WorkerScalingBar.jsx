import { useWorker } from '../context/WorkerContext.jsx'

const STATUS_DOT = {
  ready:        { color: '#4ade80', label: 'ready' },
  in_use:       { color: '#60a5fa', label: 'in use' },
  provisioning: { color: '#f59e0b', label: 'provisioning' },
  tearing_down: { color: '#f59e0b', label: 'tearing down' },
  deleted:      { color: '#6b7280', label: 'deleted' },
}

export default function WorkerScalingBar() {
  const { pools, error } = useWorker()

  if (error) {
    return (
      <div className="worker-bar">
        <span className="worker-label" style={{ color: '#f87171' }}>Pools unavailable</span>
      </div>
    )
  }

  if (!pools.length) {
    return (
      <div className="worker-bar">
        <span className="worker-label" style={{ color: 'var(--color-text-muted)' }}>No worker pools</span>
      </div>
    )
  }

  return (
    <div className="worker-bar" style={{ flexDirection: 'column', alignItems: 'stretch', gap: 8 }}>
      {pools.map(pool => {
        const dot = STATUS_DOT[pool.status] || STATUS_DOT.ready
        const workerCount = pool.replicas
        return (
          <div key={pool.id} style={{ display: 'flex', flexDirection: 'column', gap: 2, minWidth: 0 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 6, minWidth: 0 }}>
              <span
                style={{
                  flexShrink: 0,
                  width: 8,
                  height: 8,
                  borderRadius: '50%',
                  background: dot.color,
                }}
              />
              <span
                style={{
                  fontSize: 14,
                  fontWeight: 600,
                  color: 'var(--color-text)',
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                  whiteSpace: 'nowrap',
                  flex: 1,
                }}
                title={pool.name}
              >
                {pool.name}
              </span>
            </div>
            <div style={{ display: 'flex', gap: 8, paddingLeft: 14, alignItems: 'center' }}>
              <span style={{ fontSize: 11, color: dot.color, fontWeight: 500 }}>
                {dot.label}
              </span>
              <span style={{ fontSize: 11, color: 'var(--color-text-muted)' }}>·</span>
              <span style={{ fontSize: 11, color: 'var(--color-text-muted)' }}>
                {workerCount} {workerCount === 1 ? 'worker' : 'workers'}
              </span>
            </div>
          </div>
        )
      })}
    </div>
  )
}
