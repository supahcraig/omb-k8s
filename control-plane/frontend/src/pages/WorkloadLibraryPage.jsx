import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { listWorkloads, createWorkload, updateWorkload, deleteWorkload } from '../api.js'

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

function WorkloadEditor({ workload, onSave, onCancel }) {
  const [name, setName] = useState(workload?.name || '')
  const [description, setDescription] = useState(workload?.description || '')
  const [content, setContent] = useState(workload?.content || '')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState(null)

  async function handleSave() {
    if (!name.trim()) { setError('Name is required.'); return }
    if (!content.trim()) { setError('Content is required.'); return }
    setSaving(true)
    setError(null)
    try {
      await onSave({ name: name.trim(), description: description.trim() || null, content })
    } catch (e) {
      setError(e.message)
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="inline-editor">
      <div className="form-row">
        <div className="form-group">
          <label className="form-label">Name</label>
          <input className="form-input" value={name} onChange={e => setName(e.target.value)} />
        </div>
        <div className="form-group">
          <label className="form-label">Description (optional)</label>
          <input className="form-input" value={description} onChange={e => setDescription(e.target.value)} />
        </div>
      </div>
      <div className="form-group">
        <label className="form-label">Workload YAML</label>
        <textarea className="form-textarea tall" value={content} onChange={e => setContent(e.target.value)} />
      </div>
      {error && <div className="alert alert-error">{error}</div>}
      <div className="flex gap-8">
        <button className="btn btn-primary" onClick={handleSave} disabled={saving}>
          {saving ? <><span className="spinner" /> Saving…</> : 'Save'}
        </button>
        <button className="btn btn-secondary" onClick={onCancel}>Cancel</button>
      </div>
    </div>
  )
}

function WorkloadRow({ workload, editable, onUse, onClone, onEdit, onDelete }) {
  const [editing, setEditing] = useState(false)
  const [confirmDelete, setConfirmDelete] = useState(false)
  const params = parseWorkloadParams(workload.content)

  async function handleEdit(data) {
    await onEdit(workload.id, data)
    setEditing(false)
  }

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
          <button className="btn btn-primary btn-sm" onClick={() => onUse(workload)}>
            Use
          </button>
          {editable ? (
            <>
              <button className="btn btn-secondary btn-sm" onClick={() => setEditing(e => !e)}>
                Edit
              </button>
              {confirmDelete ? (
                <>
                  <span className="text-small text-muted">Confirm?</span>
                  <button className="btn btn-danger btn-sm" onClick={() => onDelete(workload.id)}>
                    Delete
                  </button>
                  <button className="btn btn-secondary btn-sm" onClick={() => setConfirmDelete(false)}>
                    Cancel
                  </button>
                </>
              ) : (
                <button className="btn btn-danger btn-sm" onClick={() => setConfirmDelete(true)}>
                  Delete
                </button>
              )}
            </>
          ) : (
            <button className="btn btn-secondary btn-sm" onClick={() => onClone(workload)}>
              Clone to Custom
            </button>
          )}
        </div>
      </div>
      {editing && (
        <WorkloadEditor
          workload={workload}
          onSave={handleEdit}
          onCancel={() => setEditing(false)}
        />
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
    navigate('/', { state: { workloadContent: workload.content, workloadName: workload.name } })
  }

  async function handleClone(workload) {
    try {
      await createWorkload({
        name: `${workload.name} (copy)`,
        content: workload.content,
        cloned_from_id: workload.id,
      })
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

  async function handleCreate(data) {
    await createWorkload(data)
    await load()
    setCreatingNew(false)
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
            <WorkloadRow
              key={w.id}
              workload={w}
              editable={false}
              onUse={handleUse}
              onClone={handleClone}
            />
          ))
        )}
      </div>

      {/* ── Custom section ──────────────────────────────────────── */}
      <div className="card">
        <div className="section-label">Custom Workloads</div>
        {creatingNew && (
          <WorkloadEditor
            workload={null}
            onSave={handleCreate}
            onCancel={() => setCreatingNew(false)}
          />
        )}
        {workloads.custom.length === 0 && !creatingNew ? (
          <div className="empty-state">
            <p>No custom workloads yet. Clone a bundled workload or create a new one.</p>
          </div>
        ) : (
          workloads.custom.map(w => (
            <WorkloadRow
              key={w.id}
              workload={w}
              editable={true}
              onUse={handleUse}
              onEdit={handleEdit}
              onDelete={handleDelete}
            />
          ))
        )}
      </div>
    </div>
  )
}
