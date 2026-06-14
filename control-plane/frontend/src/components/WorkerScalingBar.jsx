import { useWorker } from '../context/WorkerContext.jsx'

const STATUS_DOT = {
  ready:        { color: '#4ade80', title: 'Ready' },
  in_use:       { color: '#60a5fa', title: 'In use' },
  provisioning: { color: '#f59e0b', title: 'Provisioning' },
  tearing_down: { color: '#f59e0b', title: 'Tearing down' },
  deleted:      { color: '#6b7280', title: 'Deleted' },
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
    <div className="worker-bar" style={{ flexDirection: 'column', alignItems: 'stretch', gap: 4 }}>
      {pools.map(pool => {
        const dot = STATUS_DOT[pool.status] || STATUS_DOT.ready
        return (
          <div key={pool.id} style={{ display: 'flex', alignItems: 'center', gap: 6, minWidth: 0 }}>
            <span
              style={{
                flexShrink: 0,
                width: 7,
                height: 7,
                borderRadius: '50%',
                background: dot.color,
              }}
              title={dot.title}
            />
            <span
              style={{
                fontSize: 12,
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
            <span style={{ fontSize: 11, color: 'var(--color-text-muted)', flexShrink: 0 }}>
              {pool.replicas}w
            </span>
          </div>
        )
      })}
    </div>
  )
}
