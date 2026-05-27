import { BrowserRouter, Routes, Route } from 'react-router-dom'
import { WorkerProvider } from './context/WorkerContext.jsx'
import { SettingsProvider } from './context/SettingsContext.jsx'
import Layout from './components/Layout.jsx'
import RunsPage from './pages/RunsPage.jsx'
import NewRunPage from './pages/NewRunPage.jsx'
import RunDetailPage from './pages/RunDetailPage.jsx'
import SweepsPage from './pages/SweepsPage.jsx'
import NewSweepPage from './pages/NewSweepPage.jsx'
import SweepDetailPage from './pages/SweepDetailPage.jsx'
import WorkloadLibraryPage from './pages/WorkloadLibraryPage.jsx'
import SettingsPage from './pages/SettingsPage.jsx'
import ClusterPage from './pages/ClusterPage.jsx'

export default function App() {
  return (
    <SettingsProvider>
      <WorkerProvider>
        <BrowserRouter>
          <Layout>
            <Routes>
              <Route path="/" element={<RunsPage />} />
              <Route path="/runs/new" element={<NewRunPage />} />
              <Route path="/runs/:id" element={<RunDetailPage />} />
              <Route path="/sweeps" element={<SweepsPage />} />
              <Route path="/sweeps/new" element={<NewSweepPage />} />
              <Route path="/sweeps/:id" element={<SweepDetailPage />} />
              <Route path="/workloads" element={<WorkloadLibraryPage />} />
              <Route path="/settings" element={<SettingsPage />} />
              <Route path="/cluster" element={<ClusterPage />} />
            </Routes>
          </Layout>
        </BrowserRouter>
      </WorkerProvider>
    </SettingsProvider>
  )
}
