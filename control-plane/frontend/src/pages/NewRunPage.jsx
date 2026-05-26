import { useEffect, useMemo, useState } from 'react'
import { Link, useLocation, useNavigate } from 'react-router-dom'
import { listRuns, createRun, getRun } from '../api.js'
import { useWorker } from '../context/WorkerContext.jsx'
import { useSettings } from '../context/SettingsContext.jsx'
import DriverForm from '../components/DriverForm.jsx'
import WorkloadForm, { parseWorkloadYaml } from '../components/WorkloadForm.jsx'

function PanelBadge({ color, children }) {
  return (
    <div style={{
      display: 'inline-block',
      marginBottom: 12,
      padding: '3px 10px',
      borderRadius: 12,
      background: color + '22',
      border: `1px solid ${color}55`,
      color,
      fontSize: 11,
      fontWeight: 700,
      letterSpacing: '0.06em',
      textTransform: 'uppercase',
    }}>
      {children}
    </div>
  )
}

export default function NewRunPage() {
  const location = useLocation()
  const navigate = useNavigate()
  const { workersReady, status } = useWorker()
  const { hasClusterConfig } = useSettings()

  const fromLibrary = !!location.state?.workloadContent
  const initialWorkloadContent = location.state?.workloadContent || ''
  const initialWorkloadName    = location.state?.workloadName    || ''

  const [name, setName]               = useState(initialWorkloadName ? `Run — ${initialWorkloadName}` : '')
  const [driverYaml, setDriverYaml]   = useState('')
  const [workloadYaml, setWorkloadYaml] = useState(initialWorkloadContent)
  const [submitting, setSubmitting]   = useState(false)
  const [error, setError]             = useState(null)
  // null = fetching, false = no prior run, object = fetched run
  const [lastRun, setLastRun]         = useState(fromLibrary ? false : null)

  useEffect(() => {
    if (fromLibrary) return
    listRuns()
      .then(runs => {
        if (runs.length === 0) { setLastRun(false); return }
        return getRun(runs[0].id).then(setLastRun).catch(() => setLastRun(false))
      })
      .catch(() => setLastRun(false))
  }, [])

  const initialDriverContent  = fromLibrary ? '' : (lastRun?.driver_config  || '')
  const initialWorkload        = fromLibrary ? initialWorkloadContent : (lastRun?.workload_config || '')

  const projectedLoad = useMemo(() => {
    const { values } = parseWorkloadYaml(workloadYaml)
    const totalMsgSec = Number(values.producerRate) || 0
    const msgSize     = Number(values.messageSize)  || 1024
    const totalMBSec  = (totalMsgSec * msgSize) / 1_048_576
    const perProducerCount  = (Number(values.producersPerTopic) || 1) * (Number(values.topics) || 1)
    const totalPartitions   = (Number(values.topics) || 1) * (Number(values.partitionsPerTopic) || 1)

    const batchSizeMatch = driverYaml.match(/batch\.size=(\d+)/)
    const lingerMsMatch  = driverYaml.match(/linger\.ms=(\d+)/)
    const batchSize = batchSizeMatch ? Number(batchSizeMatch[1]) : 131072
    const lingerMs  = lingerMsMatch  ? Number(lingerMsMatch[1])  : 1

    const perPartitionMsgSec  = totalPartitions > 0 ? totalMsgSec / totalPartitions : 0
    const perPartitionMBSec   = totalPartitions > 0 ? totalMBSec  / totalPartitions : 0
    const msgsPerBatch        = Math.floor(batchSize / Math.max(1, msgSize))
    const msFillBatch         = perPartitionMsgSec > 0 ? (msgsPerBatch / perPartitionMsgSec) * 1000 : Infinity
    const lingerCapped        = msFillBatch > lingerMs
    const mbPerBatchActual    = lingerCapped && perPartitionMsgSec > 0
      ? (perPartitionMsgSec * (lingerMs / 1000) * msgSize) / 1_048_576
      : null

    return {
      totalMsgSec, totalMBSec,
      perProducerMsgSec: perProducerCount > 0 ? totalMsgSec / perProducerCount : 0,
      perProducerMBSec:  perProducerCount > 0 ? totalMBSec  / perProducerCount : 0,
      perPartitionMsgSec, perPartitionMBSec,
      msgsPerBatch, msFillBatch, lingerMs, mbPerBatchActual,
    }
  }, [workloadYaml, driverYaml])

  const notReady     = !workersReady
  const noCluster    = !hasClusterConfig
  const blockMessage = status
    ? `Waiting for workers: ${status.ready}/${status.desired} ready. Please wait before starting a run.`
    : 'Worker status unknown. Please wait…'

  async function handleSubmit(e) {
    e.preventDefault()
    if (notReady || noCluster) return
    if (!driverYaml.trim() || !workloadYaml.trim()) {
      setError('Driver and Workload configuration are required.')
      return
    }
    setSubmitting(true)
    setError(null)
    try {
      await createRun({
        name: name.trim() || null,
        driver_content:   driverYaml,
        workload_content: workloadYaml,
      })
      navigate('/')
    } catch (e) {
      setError(e.message)
    } finally {
      setSubmitting(false)
    }
  }

  // Wait for the last-run prefill fetch before rendering the form
  if (lastRun === null) {
    return <div className="text-muted mt-20">Loading…</div>
  }

  return (
    <form onSubmit={handleSubmit}>
      <div className="card mb-20">
        <div className="card-header">
          <h2>New Run</h2>
          <button type="submit" className="btn btn-launch" disabled={submitting || notReady || noCluster}>
            {submitting ? <><span className="spinner" /> Launching…</> : 'Launch Run'}
          </button>
        </div>
        <div className="card-body">
          {notReady && status && <div className="alert alert-warning mb-16">{blockMessage}</div>}
          {noCluster && (
            <div className="alert alert-warning mb-16">
              Configure cluster settings before launching a run.{' '}
              <Link to="/settings" style={{ color: 'var(--color-primary)' }}>Go to Settings</Link>
            </div>
          )}
          <div className="form-group">
            <label className="form-label">Run Name (optional)</label>
            <input className="form-input" value={name} onChange={e => setName(e.target.value)}
              placeholder="e.g. 1KB 100-partition baseline" />
          </div>
          <hr className="divider" />
          <div className="projected-load" style={{ marginBottom: 16 }}>
            <div className="projected-load-title">Projected Load</div>
            <div className="projected-load-grid" style={{ gridTemplateColumns: '110px 1fr 1fr' }}>
              <span>Total</span>
              <span>{projectedLoad.totalMsgSec.toLocaleString()} msg/s</span>
              <span>{projectedLoad.totalMBSec.toFixed(1)} MB/s</span>
              <span>Per producer</span>
              <span>{projectedLoad.perProducerMsgSec.toLocaleString(undefined, { maximumFractionDigits: 0 })} msg/s</span>
              <span>{projectedLoad.perProducerMBSec.toFixed(1)} MB/s</span>
              <span>Per partition</span>
              <span>{projectedLoad.perPartitionMsgSec.toLocaleString(undefined, { maximumFractionDigits: 1 })} msg/s</span>
              <span>{projectedLoad.perPartitionMBSec.toFixed(2)} MB/s</span>
              <span style={{ borderTop: '1px solid rgba(74,222,128,0.15)', paddingTop: 4, marginTop: 2 }}>Msgs / batch</span>
              <span style={{ borderTop: '1px solid rgba(74,222,128,0.15)', paddingTop: 4, marginTop: 2 }}>
                {projectedLoad.msgsPerBatch.toLocaleString()} msgs
              </span>
              <span style={{ borderTop: '1px solid rgba(74,222,128,0.15)', paddingTop: 4, marginTop: 2 }}>
                {projectedLoad.msFillBatch === Infinity
                  ? '—'
                  : `fills in ${projectedLoad.msFillBatch < 1 ? '<1' : projectedLoad.msFillBatch.toFixed(1)} ms`}
                <span style={{ opacity: 0.6, marginLeft: 6 }}>
                  (linger: {projectedLoad.lingerMs} ms
                  {projectedLoad.msFillBatch !== Infinity && (
                    projectedLoad.msFillBatch <= projectedLoad.lingerMs
                      ? ' — batch-full'
                      : ' — linger-capped'
                  )})
                </span>
                {projectedLoad.mbPerBatchActual != null && (
                  <span style={{ opacity: 0.8, marginLeft: 6 }}>
                    · {projectedLoad.mbPerBatchActual < 0.01
                        ? `${(projectedLoad.mbPerBatchActual * 1024).toFixed(2)} KB/batch`
                        : `${projectedLoad.mbPerBatchActual.toFixed(3)} MB/batch`}
                  </span>
                )}
              </span>
            </div>
          </div>
          {error && <div className="alert alert-error mt-16">{error}</div>}
        </div>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', columnGap: 20, rowGap: 6, marginBottom: 20 }}>
        <div style={{ background: 'var(--color-surface)', border: '1px solid var(--color-border)', borderTop: '3px solid #3b82f6', borderRadius: 'var(--radius)', padding: 16 }}>
          <PanelBadge color="#3b82f6">Driver</PanelBadge>
          <DriverForm onChange={setDriverYaml} initialYaml={initialDriverContent} />
        </div>
        <div style={{ background: 'var(--color-surface)', border: '1px solid var(--color-border)', borderTop: '3px solid #10b981', borderRadius: 'var(--radius)', padding: 16 }}>
          <PanelBadge color="#10b981">Workload</PanelBadge>
          <WorkloadForm initialYaml={initialWorkload} onChange={setWorkloadYaml} />
        </div>
        <div style={{ background: '#0d1018', border: '1px solid var(--color-border)', borderTop: '3px solid #3b82f6', borderRadius: 'var(--radius)', padding: 16, display: 'flex', flexDirection: 'column' }}>
          <PanelBadge color="#3b82f6">Driver YAML</PanelBadge>
          <textarea className="form-textarea"
            style={{ flex: 1, minHeight: 420, resize: 'vertical', fontFamily: 'monospace', fontSize: 12, background: '#0d1018' }}
            value={driverYaml} onChange={e => setDriverYaml(e.target.value)} />
        </div>
        <div style={{ background: '#0d1018', border: '1px solid var(--color-border)', borderTop: '3px solid #10b981', borderRadius: 'var(--radius)', padding: 16, display: 'flex', flexDirection: 'column' }}>
          <PanelBadge color="#10b981">Workload YAML</PanelBadge>
          <textarea className="form-textarea"
            style={{ flex: 1, minHeight: 420, resize: 'vertical', fontFamily: 'monospace', fontSize: 12, background: '#0d1018' }}
            value={workloadYaml} onChange={e => setWorkloadYaml(e.target.value)} />
        </div>
      </div>
    </form>
  )
}
