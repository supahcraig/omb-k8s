import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { listWorkloads, createWorkload, updateWorkload, deleteWorkload } from '../api.js'
import { listDrivers, createDriver, updateDriver, deleteDriver } from '../api.js'
import WorkloadForm from '../components/WorkloadForm.jsx'
import DriverForm from '../components/DriverForm.jsx'

// ---------------------------------------------------------------------------
// Workload helpers
// ---------------------------------------------------------------------------

function parseWorkloadParams(content) {
  try {
    const lines = content.split('\n')
    const result = {}
    for (const line of lines) {
      const msgMatch = line.match(/^\s*messageSize\s*:\s*(\d+)/)
      if (msgMatch) result.messageSize = parseInt(msgMatch[1])
      const partMatch = line.match(/^\s*partitionsPerTopic\s*:\s*(\d+)/)
      if (partMatch) result.partitions = parseInt(partMatch[1])
      const rateMatch = line.match(/^\s*producerRate\s*:\s*(\d+)/)
      if (rateMatch) result.rate = parseInt(rateMatch[1])
    }
    return result
  } catch {
    return {}
  }
}

function formatMessageSize(bytes) {
  if (!bytes) return null
  if (bytes >= 1024) return `${bytes / 1024}KB`
  return `${bytes}B`
}

function formatRate(rate) {
  if (!rate) return null
  if (rate >= 1000000) return `${(rate / 1000000).toFixed(1)}M msg/s`
  if (rate >= 1000) return `${(rate / 1000).toFixed(0)}K msg/s`
  return `${rate} msg/s`
}

// ---------------------------------------------------------------------------
// Driver helpers
// ---------------------------------------------------------------------------

function parseDriverTags(content) {
  const tags = []
  for (const line of content.split('\n')) {
    const t = line.trim()
    if (t.startsWith('name:')) {
      const val = t.split(':')[1]?.trim()
      if (val) tags.push(val)
    } else if (t.startsWith('acks=')) {
      tags.push(`acks=${t.split('=')[1]}`)
    } else if (t.startsWith('compression.type=')) {
      const v = t.split('=')[1]
      if (v && v !== 'none') tags.push(`${v}`)
    } else if (t.startsWith('batch.size=')) {
      const n = parseInt(t.split('=')[1])
      if (!isNaN(n)) tags.push(n >= 1024 ? `${n / 1024}KB batch` : `${n}B batch`)
    }
  }
  return tags
}

// ---------------------------------------------------------------------------
// Shared card components
// ---------------------------------------------------------------------------

function WorkloadRow({ workload, editable, onUse, onClone, onEdit, onDelete }) {
  const [editing, setEditing] = useState(false)
  const [confirmDelete, setConfirmDelete] = useState(false)
  const [editName, setEditName] = useState(workload.name)
  const [editDesc, setEditDesc] = useState(workload.description || '')
  const [editYaml, setEditYaml] = useState(workload.content)
  const [editError, setEditError] = useState(null)
  const params = parseWorkloadParams(workload.content)

  return (
    <>
      <div className="workload-card">
        <div>
          <div className="workload-name">{workload.name}</div>
          {workload.description && (
            <div className="workload-desc">{workload.description}</div>
          )}
          <div className="workload-tags">
            {params.messageSize && <span className="workload-tag">{formatMessageSize(params.messageSize)}</span>}
            {params.partitions && <span className="workload-tag">{params.partitions} partitions</span>}
            {params.rate && <span className="workload-tag">{formatRate(params.rate)}</span>}
            {editable && workload.updated_at && (
              <span className="workload-tag" title={workload.updated_at}>
                Modified {new Date(workload.updated_at).toLocaleDateString()}
              </span>
            )}
          </div>
        </div>
        <div className="workload-actions">
          <button className="btn btn-primary btn-sm" onClick={() => onUse(workload)}>Use</button>
          {editable ? (
            <>
              <button className="btn btn-secondary btn-sm" onClick={() => setEditing(e => !e)}>
                {editing ? 'Close' : 'Edit'}
              </button>
              {confirmDelete ? (
                <>
                  <span className="text-small text-muted">Confirm?</span>
                  <button className="btn btn-danger btn-sm" onClick={() => onDelete(workload.id)}>Delete</button>
                  <button className="btn btn-secondary btn-sm" onClick={() => setConfirmDelete(false)}>Cancel</button>
                </>
              ) : (
                <button className="btn btn-danger btn-sm" onClick={() => setConfirmDelete(true)}>Delete</button>
              )}
            </>
          ) : (
            <button className="btn btn-secondary btn-sm" onClick={() => onClone(workload)}>Clone to Custom</button>
          )}
        </div>
      </div>

      {editing && (
        <div className="inline-editor">
          <div className="form-row">
            <div className="form-group">
              <label className="form-label">Name</label>
              <input className="form-input" value={editName} onChange={e => setEditName(e.target.value)} />
            </div>
            <div className="form-group">
              <label className="form-label">Description (optional)</label>
              <input className="form-input" value={editDesc} onChange={e => setEditDesc(e.target.value)} />
            </div>
          </div>
          <WorkloadForm initialYaml={workload.content} onChange={setEditYaml} />
          {editError && <div className="alert alert-error mt-8">{editError}</div>}
          <div className="flex gap-8 mt-12">
            <button className="btn btn-primary" onClick={async () => {
              if (!editName.trim()) { setEditError('Name is required.'); return }
              setEditError(null)
              await onEdit(workload.id, { name: editName.trim(), description: editDesc.trim() || null, content: editYaml })
              setEditing(false)
            }}>Save</button>
            <button className="btn btn-secondary" onClick={() => setEditing(false)}>Cancel</button>
          </div>
        </div>
      )}
    </>
  )
}

function DriverRow({ driver, editable, onUse, onClone, onEdit, onDelete }) {
  const [editing, setEditing] = useState(false)
  const [confirmDelete, setConfirmDelete] = useState(false)
  const [editName, setEditName] = useState(driver.name)
  const [editDesc, setEditDesc] = useState(driver.description || '')
  const [editYaml, setEditYaml] = useState(driver.content)
  const [editError, setEditError] = useState(null)
  const tags = parseDriverTags(driver.content)

  return (
    <>
      <div className="workload-card">
        <div>
          <div className="workload-name">{driver.name}</div>
          {driver.description && (
            <div className="workload-desc">{driver.description}</div>
          )}
          <div className="workload-tags">
            {tags.map((t, i) => <span key={i} className="workload-tag">{t}</span>)}
            {editable && driver.updated_at && (
              <span className="workload-tag">Modified {new Date(driver.updated_at).toLocaleDateString()}</span>
            )}
          </div>
        </div>
        <div className="workload-actions">
          <button className="btn btn-primary btn-sm" onClick={() => onUse(driver)}>Use</button>
          {editable ? (
            <>
              <button className="btn btn-secondary btn-sm" onClick={() => setEditing(e => !e)}>
                {editing ? 'Close' : 'Edit'}
              </button>
              {confirmDelete ? (
                <>
                  <span className="text-small text-muted">Confirm?</span>
                  <button className="btn btn-danger btn-sm" onClick={() => onDelete(driver.id)}>Delete</button>
                  <button className="btn btn-secondary btn-sm" onClick={() => setConfirmDelete(false)}>Cancel</button>
                </>
              ) : (
                <button className="btn btn-danger btn-sm" onClick={() => setConfirmDelete(true)}>Delete</button>
              )}
            </>
          ) : (
            <button className="btn btn-secondary btn-sm" onClick={() => onClone(driver)}>Clone to Custom</button>
          )}
        </div>
      </div>

      {editing && (
        <div className="inline-editor">
          <div className="form-row">
            <div className="form-group">
              <label className="form-label">Name</label>
              <input className="form-input" value={editName} onChange={e => setEditName(e.target.value)} />
            </div>
            <div className="form-group">
              <label className="form-label">Description (optional)</label>
              <input className="form-input" value={editDesc} onChange={e => setEditDesc(e.target.value)} />
            </div>
          </div>
          <DriverForm initialYaml={driver.content} onChange={setEditYaml} />
          {editError && <div className="alert alert-error mt-8">{editError}</div>}
          <div className="flex gap-8 mt-12">
            <button className="btn btn-primary" onClick={async () => {
              if (!editName.trim()) { setEditError('Name is required.'); return }
              setEditError(null)
              await onEdit(driver.id, { name: editName.trim(), description: editDesc.trim() || null, content: editYaml })
              setEditing(false)
            }}>Save</button>
            <button className="btn btn-secondary" onClick={() => setEditing(false)}>Cancel</button>
          </div>
        </div>
      )}
    </>
  )
}

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

export default function WorkloadLibraryPage() {
  const navigate = useNavigate()
  const [tab, setTab] = useState('workloads')

  // Workload state
  const [workloads, setWorkloads] = useState({ bundled: [], custom: [] })
  const [wLoading, setWLoading] = useState(true)
  const [wError, setWError] = useState(null)
  const [creatingWorkload, setCreatingWorkload] = useState(false)
  const [newWName, setNewWName] = useState('')
  const [newWYaml, setNewWYaml] = useState('')
  const [wCreateError, setWCreateError] = useState(null)
  const [wCreating, setWCreating] = useState(false)

  // Driver state
  const [drivers, setDrivers] = useState({ bundled: [], custom: [] })
  const [dLoading, setDLoading] = useState(true)
  const [dError, setDError] = useState(null)
  const [creatingDriver, setCreatingDriver] = useState(false)
  const [newDName, setNewDName] = useState('')
  const [newDYaml, setNewDYaml] = useState('')
  const [dCreateError, setDCreateError] = useState(null)
  const [dCreating, setDCreating] = useState(false)

  async function loadWorkloads() {
    try {
      setWorkloads(await listWorkloads())
      setWError(null)
    } catch (e) {
      setWError(e.message)
    } finally {
      setWLoading(false)
    }
  }

  async function loadDrivers() {
    try {
      setDrivers(await listDrivers())
      setDError(null)
    } catch (e) {
      setDError(e.message)
    } finally {
      setDLoading(false)
    }
  }

  useEffect(() => { loadWorkloads(); loadDrivers() }, [])

  const TAB_STYLE = active => ({
    padding: '6px 20px', borderRadius: 6, border: 'none', cursor: 'pointer', fontWeight: 600, fontSize: 13,
    background: active ? 'var(--color-primary)' : 'transparent',
    color: active ? '#fff' : 'var(--color-text-muted)',
  })

  return (
    <div>
      <div className="page-header">
        <h1 className="page-title">Library</h1>
        <div style={{ display: 'flex', gap: 4, background: 'var(--color-surface)', border: '1px solid var(--color-border)', borderRadius: 8, padding: 3 }}>
          <button style={TAB_STYLE(tab === 'workloads')} onClick={() => setTab('workloads')}>Workloads</button>
          <button style={TAB_STYLE(tab === 'drivers')} onClick={() => setTab('drivers')}>Drivers</button>
        </div>
        {tab === 'workloads' && (
          <button className="btn btn-primary" onClick={() => setCreatingWorkload(true)}>+ New Custom Workload</button>
        )}
        {tab === 'drivers' && (
          <button className="btn btn-primary" onClick={() => setCreatingDriver(true)}>+ New Custom Driver</button>
        )}
      </div>

      {/* ── Workloads tab ──────────────────────────────────────────────── */}
      {tab === 'workloads' && (
        <>
          {wLoading ? <div className="text-muted">Loading…</div> : wError ? (
            <div className="alert alert-error">{wError}</div>
          ) : (
            <>
              <div className="card mb-20">
                <div className="section-label">Bundled Workloads — read-only, seeded from OMB repo</div>
                {workloads.bundled.length === 0 ? (
                  <div className="empty-state"><p>No bundled workloads found.</p></div>
                ) : workloads.bundled.map(w => (
                  <WorkloadRow key={w.id} workload={w} editable={false}
                    onUse={w => navigate('/runs/new', { state: { workloadContent: w.content, workloadName: w.name } })}
                    onClone={async w => { await createWorkload({ name: `${w.name} (copy)`, content: w.content, cloned_from_id: w.id }); loadWorkloads() }}
                  />
                ))}
              </div>

              <div className="card">
                <div className="section-label">Custom Workloads</div>
                {creatingWorkload && (
                  <div className="inline-editor">
                    <div className="form-group">
                      <label className="form-label">Name</label>
                      <input className="form-input" value={newWName} onChange={e => setNewWName(e.target.value)} />
                    </div>
                    <WorkloadForm onChange={setNewWYaml} />
                    {wCreateError && <div className="alert alert-error mt-8">{wCreateError}</div>}
                    <div className="flex gap-8 mt-12">
                      <button className="btn btn-primary" disabled={wCreating} onClick={async () => {
                        if (!newWName.trim()) { setWCreateError('Name is required.'); return }
                        setWCreating(true); setWCreateError(null)
                        try {
                          await createWorkload({ name: newWName.trim(), content: newWYaml })
                          await loadWorkloads()
                          setCreatingWorkload(false); setNewWName(''); setNewWYaml('')
                        } catch (e) { setWCreateError(e.message) }
                        finally { setWCreating(false) }
                      }}>
                        {wCreating ? <><span className="spinner" /> Saving…</> : 'Save'}
                      </button>
                      <button className="btn btn-secondary" onClick={() => setCreatingWorkload(false)}>Cancel</button>
                    </div>
                  </div>
                )}
                {workloads.custom.length === 0 && !creatingWorkload ? (
                  <div className="empty-state"><p>No custom workloads yet. Clone a bundled workload or create a new one.</p></div>
                ) : workloads.custom.map(w => (
                  <WorkloadRow key={w.id} workload={w} editable={true}
                    onUse={w => navigate('/runs/new', { state: { workloadContent: w.content, workloadName: w.name } })}
                    onEdit={async (id, data) => { await updateWorkload(id, data); loadWorkloads() }}
                    onDelete={async id => { try { await deleteWorkload(id); await loadWorkloads() } catch (e) { alert(e.message) } }}
                  />
                ))}
              </div>
            </>
          )}
        </>
      )}

      {/* ── Drivers tab ────────────────────────────────────────────────── */}
      {tab === 'drivers' && (
        <>
          {dLoading ? <div className="text-muted">Loading…</div> : dError ? (
            <div className="alert alert-error">{dError}</div>
          ) : (
            <>
              <div className="card mb-20">
                <div className="section-label">Bundled Drivers — read-only, based on OMB repo examples</div>
                {drivers.bundled.length === 0 ? (
                  <div className="empty-state"><p>No bundled drivers found.</p></div>
                ) : drivers.bundled.map(d => (
                  <DriverRow key={d.id} driver={d} editable={false}
                    onUse={d => navigate('/runs/new', { state: { driverContent: d.content, driverName: d.name } })}
                    onClone={async d => { await createDriver({ name: `${d.name} (copy)`, content: d.content, cloned_from_id: d.id }); loadDrivers() }}
                  />
                ))}
              </div>

              <div className="card">
                <div className="section-label">Custom Drivers</div>
                {creatingDriver && (
                  <div className="inline-editor">
                    <div className="form-group">
                      <label className="form-label">Name</label>
                      <input className="form-input" value={newDName} onChange={e => setNewDName(e.target.value)} />
                    </div>
                    <DriverForm onChange={setNewDYaml} />
                    {dCreateError && <div className="alert alert-error mt-8">{dCreateError}</div>}
                    <div className="flex gap-8 mt-12">
                      <button className="btn btn-primary" disabled={dCreating} onClick={async () => {
                        if (!newDName.trim()) { setDCreateError('Name is required.'); return }
                        setDCreating(true); setDCreateError(null)
                        try {
                          await createDriver({ name: newDName.trim(), content: newDYaml })
                          await loadDrivers()
                          setCreatingDriver(false); setNewDName(''); setNewDYaml('')
                        } catch (e) { setDCreateError(e.message) }
                        finally { setDCreating(false) }
                      }}>
                        {dCreating ? <><span className="spinner" /> Saving…</> : 'Save'}
                      </button>
                      <button className="btn btn-secondary" onClick={() => setCreatingDriver(false)}>Cancel</button>
                    </div>
                  </div>
                )}
                {drivers.custom.length === 0 && !creatingDriver ? (
                  <div className="empty-state"><p>No custom drivers yet. Clone a bundled driver or create a new one.</p></div>
                ) : drivers.custom.map(d => (
                  <DriverRow key={d.id} driver={d} editable={true}
                    onUse={d => navigate('/runs/new', { state: { driverContent: d.content, driverName: d.name } })}
                    onEdit={async (id, data) => { await updateDriver(id, data); loadDrivers() }}
                    onDelete={async id => { try { await deleteDriver(id); await loadDrivers() } catch (e) { alert(e.message) } }}
                  />
                ))}
              </div>
            </>
          )}
        </>
      )}
    </div>
  )
}
