import { createContext, useContext, useEffect, useRef, useState } from 'react'
import { getWorkerStatus, scaleWorkers } from '../api.js'

const WorkerContext = createContext(null)

export function WorkerProvider({ children }) {
  const [status, setStatus] = useState(null)   // null = loading
  const [error, setError] = useState(null)
  const [desired, setDesiredState] = useState(1)
  const intervalRef = useRef(null)

  async function fetchStatus() {
    try {
      const data = await getWorkerStatus()
      setStatus(data)
      setError(null)
      // Keep desired in sync with StatefulSet desired if user hasn't changed it
      setDesiredState(prev => prev === 1 && data.desired > 1 ? data.desired : prev)
    } catch (e) {
      setError(e.message)
    }
  }

  useEffect(() => {
    fetchStatus()
    intervalRef.current = setInterval(fetchStatus, 5000)
    return () => clearInterval(intervalRef.current)
  }, [])

  async function scale(replicas) {
    try {
      await scaleWorkers(replicas)
      setDesiredState(replicas)
      await fetchStatus()
    } catch (e) {
      throw e
    }
  }

  const ready = status ? status.ready : 0
  const desiredFromServer = status ? status.desired : 0
  const workersReady = status !== null && status.ready === status.desired && status.desired > 0

  return (
    <WorkerContext.Provider value={{
      status,
      error,
      desired,
      setDesired: setDesiredState,
      scale,
      workersReady,
      ready,
      desiredFromServer,
      refresh: fetchStatus,
    }}>
      {children}
    </WorkerContext.Provider>
  )
}

export function useWorker() {
  const ctx = useContext(WorkerContext)
  if (!ctx) throw new Error('useWorker must be used within WorkerProvider')
  return ctx
}
