import { useState } from 'react'
import { NavLink, Link } from 'react-router-dom'
import WorkerScalingBar from './WorkerScalingBar.jsx'
import { useSettings } from '../context/SettingsContext.jsx'

export default function Layout({ children }) {
  const { hasClusterConfig, settings } = useSettings()
  const [dismissed, setDismissed] = useState(false)

  const showBanner = settings !== undefined && !hasClusterConfig && !dismissed

  return (
    <div className="app-shell">
      <nav className="app-nav">
        <NavLink to="/" className="app-nav-brand">
          OMB <span>Control Plane</span>
        </NavLink>
        <div className="nav-links">
          <NavLink to="/" end className={({ isActive }) => 'nav-link' + (isActive ? ' active' : '')}>
            Runs
          </NavLink>
          <NavLink to="/sweeps" className={({ isActive }) => 'nav-link' + (isActive ? ' active' : '')}>
            Sweeps
          </NavLink>
          <NavLink to="/workloads" className={({ isActive }) => 'nav-link' + (isActive ? ' active' : '')}>
            Workload Library
          </NavLink>
          <NavLink to="/cluster" className={({ isActive }) => 'nav-link' + (isActive ? ' active' : '')}>
            Cluster
          </NavLink>
          <NavLink to="/settings" className={({ isActive }) => 'nav-link' + (isActive ? ' active' : '')}>
            Settings
          </NavLink>
        </div>
        <WorkerScalingBar />
      </nav>

      {showBanner && (
        <div className="setup-banner">
          <span>⚠</span>
          <span>
            Cluster not configured. Add broker address and credentials in{' '}
            <Link to="/settings">Settings</Link> before running benchmarks.
          </span>
          <button className="setup-banner-dismiss" onClick={() => setDismissed(true)} title="Dismiss">
            ×
          </button>
        </div>
      )}

      <main className="app-content">
        {children}
      </main>
    </div>
  )
}
