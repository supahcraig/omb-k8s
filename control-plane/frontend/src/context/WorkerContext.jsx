import { createContext, useContext, useEffect, useRef, useState } from 'react'
import { listWorkerPools } from '../api.js'

const WorkerContext = createContext(null)

export function WorkerProvider({ children }) {
  const [pools, setPools] = useState([])
  const [error, setError] = useState(null)
  const intervalRef = useRef(null)

  async function fetchPools() {
    try {
      const data = await listWorkerPools()
      setPools(data)
      setError(null)
    } catch (e) {
      setError(e.message)
    }
  }

  useEffect(() => {
    fetchPools()
    intervalRef.current = setInterval(fetchPools, 5000)
    return () => clearInterval(intervalRef.current)
  }, [])

  return (
    <WorkerContext.Provider value={{ pools, error, refresh: fetchPools }}>
      {children}
    </WorkerContext.Provider>
  )
}

export function useWorker() {
  const ctx = useContext(WorkerContext)
  if (!ctx) throw new Error('useWorker must be used within WorkerProvider')
  return ctx
}
