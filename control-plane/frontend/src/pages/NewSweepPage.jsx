import { Navigate } from 'react-router-dom'

// Sweep configuration is now part of the New Run page.
export default function NewSweepPage() {
  return <Navigate to="/runs/new" state={{ enableSweep: true }} replace />
}
