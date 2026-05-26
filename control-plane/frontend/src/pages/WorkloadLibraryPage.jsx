import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { listWorkloads, createWorkload, updateWorkload, deleteWorkload } from '../api.js'
import WorkloadForm from '../components/WorkloadForm.jsx'

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
            {editable && workload.last_used_at && (
              <span className="workload-tag" title={`Last run: ${workload.last_used_run_id}`}>
                Last used {new Date(workload.last_used_at).toLocaleDateString()}
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

export default function WorkloadLibraryPage() {
  const navigate = useNavigate()
  const [workloads, setWorkloads] = useState({ bundled: [], custom: [] })
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)
  const [creatingNew, setCreatingNew] = useState(false)
  const [newName, setNewName] = useState('')
  const [newYaml, setNewYaml] = useState('')
  const [createError, setCreateError] = useState(null)
  const [creating, setCreating] = useState(false)

  async function load() {
    try {
      const data = await listWorkloads()
      setWorkloads(data)
      setError(null)
    } catch (e) {
      setError(e.message)
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => { load() }, [])

  function handleUse(workload) {
    navigate('/runs/new', { state: { workloadContent: workload.content, workloadName: workload.name } })
  }

  async function handleClone(workload) {
    try {
      await createWorkload({ name: `${workload.name} (copy)`, content: workload.content, cloned_from_id: workload.id })
      await load()
    } catch (e) {
      alert(`Clone failed: ${e.message}`)
    }
  }

  async function handleEdit(id, data) {
    await updateWorkload(id, data)
    await load()
  }

  async function handleDelete(id) {
    try {
      await deleteWorkload(id)
      await load()
    } catch (e) {
      alert(`Delete failed: ${e.message}`)
    }
  }

  if (loading) return <div className="text-muted mt-20">Loading workloads…</div>
  if (error) return <div className="alert alert-error">{error}</div>

  return (
    <div>
      <div className="page-header">
        <h1 className="page-title">Workload Library</h1>
        <button className="btn btn-primary" onClick={() => setCreatingNew(true)}>
          + New Custom Workload
        </button>
      </div>

      {/* ── Bundled section ─────────────────────────────────────── */}
      <div className="card mb-20">
        <div className="section-label">Bundled Workloads — read-only, seeded from OMB repo</div>
        {workloads.bundled.length === 0 ? (
          <div className="empty-state"><p>No bundled workloads found.</p></div>
        ) : (
          workloads.bundled.map(w => (
            <WorkloadRow key={w.id} workload={w} editable={false} onUse={handleUse} onClone={handleClone} />
          ))
        )}
      </div>

      {/* ── Custom section ──────────────────────────────────────── */}
      <div className="card">
        <div className="section-label">Custom Workloads</div>

        {creatingNew && (
          <div className="inline-editor">
            <div className="form-group">
              <label className="form-label">Name</label>
              <input className="form-input" value={newName} onChange={e => setNewName(e.target.value)} />
            </div>
            <WorkloadForm onChange={setNewYaml} />
            {createError && <div className="alert alert-error mt-8">{createError}</div>}
            <div className="flex gap-8 mt-12">
              <button className="btn btn-primary" disabled={creating} onClick={async () => {
                if (!newName.trim()) { setCreateError('Name is required.'); return }
                setCreating(true); setCreateError(null)
                try {
                  await createWorkload({ name: newName.trim(), content: newYaml })
                  await load()
                  setCreatingNew(false)
                  setNewName('')
                  setNewYaml('')
                } catch (e) {
                  setCreateError(e.message)
                } finally {
                  setCreating(false)
                }
              }}>
                {creating ? <><span className="spinner" /> Saving…</> : 'Save'}
              </button>
              <button className="btn btn-secondary" onClick={() => setCreatingNew(false)}>Cancel</button>
            </div>
          </div>
        )}

        {workloads.custom.length === 0 && !creatingNew ? (
          <div className="empty-state">
            <p>No custom workloads yet. Clone a bundled workload or create a new one.</p>
          </div>
        ) : (
          workloads.custom.map(w => (
            <WorkloadRow
              key={w.id} workload={w} editable={true}
              onUse={handleUse} onEdit={handleEdit} onDelete={handleDelete}
            />
          ))
        )}
      </div>
    </div>
  )
}
