import { useState } from 'react'
import { useWorker } from '../context/WorkerContext.jsx'

export default function WorkerScalingBar() {
  const { status, error, desired, setDesired, scale, ready, desiredFromServer } = useWorker()
  const [scaling, setScaling] = useState(false)
  const [scaleError, setScaleError] = useState(null)

  const isReady = status !== null && status.ready === status.desired && status.desired > 0

  async function handleScale() {
    if (desired < 1 || desired > 20) return
    setScaling(true)
    setScaleError(null)
    try {
      await scale(desired)
    } catch (e) {
      setScaleError(e.message)
    } finally {
      setScaling(false)
    }
  }

  let readinessLabel = '—'
  let readinessClass = 'loading'

  if (error) {
    readinessLabel = 'unavailable'
    readinessClass = 'not-ready'
  } else if (status !== null) {
    readinessLabel = `${status.ready}/${status.desired} ready`
    readinessClass = isReady ? 'ready' : 'not-ready'
  }

  return (
    <div className="worker-bar">
      <span className="worker-label">Workers</span>
      <span className={`worker-readiness ${readinessClass}`}>{readinessLabel}</span>
      <input
        type="number"
        className="worker-spinner-input"
        value={desired}
        min={1}
        max={20}
        onChange={e => setDesired(Math.max(1, Math.min(20, parseInt(e.target.value) || 1)))}
        title="Desired worker count (1–20)"
      />
      <button
        className="btn-nav"
        onClick={handleScale}
        disabled={scaling || desired === desiredFromServer}
        title={desired === desiredFromServer ? 'Already at desired count' : `Scale to ${desired} workers`}
      >
        {scaling ? <span className="spinner" /> : 'Scale'}
      </button>
      {scaleError && (
        <span style={{ color: '#f87171', fontSize: 12, maxWidth: 160 }} title={scaleError}>
          Scale failed
        </span>
      )}
    </div>
  )
}
