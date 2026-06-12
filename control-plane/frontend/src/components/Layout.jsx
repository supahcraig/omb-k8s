import { useState } from 'react'
import { NavLink, Link } from 'react-router-dom'
import WorkerScalingBar from './WorkerScalingBar.jsx'
import { useSettings } from '../context/SettingsContext.jsx'
import useGrafanaUrl from '../hooks/useGrafanaUrl.js'
import { buildGrafanaUrl } from '../lib/grafanaUtils.js'

export default function Layout({ children }) {
  const { hasClusterConfig, settings } = useSettings()
  const [dismissed, setDismissed] = useState(false)
  const grafanaUrl = useGrafanaUrl()

  const showBanner = settings !== undefined && !hasClusterConfig && !dismissed

  return (
    <div className="app-shell">
      <nav className="app-nav">
        <NavLink to="/" className="app-nav-brand">
          OMB <span>Control Plane</span>
        </NavLink>

        <div className="nav-links">
          <NavLink to="/" end className={({ isActive }) => 'nav-link' + (isActive ? ' active' : '')}>
            Benchmark Runs
          </NavLink>
          <NavLink to="/runs/new" className={({ isActive }) => 'nav-link-sub' + (isActive ? ' active' : '')}>
            + New Run
          </NavLink>
          <NavLink to="/timeline" className={({ isActive }) => 'nav-link-sub' + (isActive ? ' active' : '')}>
            Timeline
          </NavLink>
          <NavLink to="/sweeps" end className={({ isActive }) => 'nav-link' + (isActive ? ' active' : '')}>
            Sweeps
          </NavLink>
          <NavLink to="/workloads" className={({ isActive }) => 'nav-link' + (isActive ? ' active' : '')}>
            Workload Library
          </NavLink>
        </div>

        <div className="nav-section-divider" />
        <div className="nav-section-label">Infrastructure</div>

        <div className="nav-links">
          <NavLink to="/cluster" className={({ isActive }) => 'nav-link' + (isActive ? ' active' : '')}>
            OMB Cluster
          </NavLink>
          <NavLink to="/settings" className={({ isActive }) => 'nav-link' + (isActive ? ' active' : '')}>
            Settings
          </NavLink>
        </div>

        {grafanaUrl && (
          <>
            <div className="nav-section-divider" />
            <div className="nav-section-label">Monitoring</div>
            <div className="nav-links">
              <a
                href={buildGrafanaUrl(grafanaUrl, 'now-6h', 'now')}
                target="_blank"
                rel="noopener noreferrer"
                className="nav-link"
              >
                Grafana ↗
              </a>
            </div>
          </>
        )}

        <div className="nav-bottom">
          <WorkerScalingBar />
        </div>
      </nav>

      <div className="app-right">
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
    </div>
  )
}
