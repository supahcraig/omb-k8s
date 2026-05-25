import { NavLink } from 'react-router-dom'
import WorkerScalingBar from './WorkerScalingBar.jsx'

export default function Layout({ children }) {
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
          <NavLink to="/settings" className={({ isActive }) => 'nav-link' + (isActive ? ' active' : '')}>
            Settings
          </NavLink>
        </div>
        <WorkerScalingBar />
      </nav>
      <main className="app-content">
        {children}
      </main>
    </div>
  )
}
