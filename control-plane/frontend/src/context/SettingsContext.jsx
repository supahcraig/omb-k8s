import { createContext, useContext, useEffect, useState } from 'react'
import { getSettings } from '../api.js'

const SettingsContext = createContext(null)

export function SettingsProvider({ children }) {
  const [settings, setSettings] = useState(undefined)  // undefined = loading
  const [loadError, setLoadError] = useState(null)

  async function reload() {
    try {
      const data = await getSettings()
      setSettings(data)
      setLoadError(null)
    } catch (e) {
      setLoadError(e.message)
      setSettings(null)
    }
  }

  useEffect(() => { reload() }, [])

  const hasClusterConfig = !!(settings?.cluster?.bootstrap_servers)

  return (
    <SettingsContext.Provider value={{ settings, hasClusterConfig, loadError, reload }}>
      {children}
    </SettingsContext.Provider>
  )
}

export function useSettings() {
  const ctx = useContext(SettingsContext)
  if (!ctx) throw new Error('useSettings must be used within SettingsProvider')
  return ctx
}
