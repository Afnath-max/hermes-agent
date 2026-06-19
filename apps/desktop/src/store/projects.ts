import { atom } from 'nanostores'

import { persistString, storedString } from '@/lib/storage'
import { activeGateway, ensureActiveGatewayOpen } from '@/store/gateway'
import type { ProjectInfo, ProjectsPayload } from '@/types/hermes'

// First-class, per-profile Projects (named, multi-folder workspaces). State is
// served by the live gateway's `projects.*` JSON-RPC methods, which wrap the
// per-profile projects.db store. The sidebar groups sessions by project folder
// membership; these atoms are the renderer's cached view.

export const $projects = atom<ProjectInfo[]>([])
export const $activeProjectId = atom<null | string>(null)
// True once a list response has landed, so the sidebar can distinguish
// "no projects yet" from "haven't loaded".
export const $projectsLoaded = atom(false)

// ── Project scope (the "you're inside a project" view, mirroring profile scope)─
// The sidebar's grouped view is a project switcher: ALL_PROJECTS shows the
// project overview (a list you drill into), and a concrete id means you've
// "entered" that project so only its worktrees/branches/sessions show. This is
// pure view state (localStorage), distinct from the durable active-project
// pointer in projects.db — though entering a project also makes it active so new
// chats land there, exactly as selecting a profile does.
export const ALL_PROJECTS = '__all_projects__'

const PROJECT_SCOPE_KEY = 'hermes.desktop.projectScope'

export const $projectScope = atom<string>(storedString(PROJECT_SCOPE_KEY) || ALL_PROJECTS)

$projectScope.subscribe(value => persistString(PROJECT_SCOPE_KEY, value || ALL_PROJECTS))

// Enter a project: scope the sidebar to it and make it the active project
// (best-effort — the durable pointer is nice-to-have, the view scope is the
// point). Never opens a session.
export function enterProject(id: string): void {
  $projectScope.set(id)

  // Only explicit, persisted projects (ids are `p_<hex>`) become active. Auto
  // projects (ids are filesystem paths) and the "No project" bucket have no
  // durable row to pin, so they're view-scope only.
  if (id.startsWith('p_')) {
    void setActiveProject(id).catch(() => undefined)
  }
}

export function exitProjectScope(): void {
  $projectScope.set(ALL_PROJECTS)
}

// Issue a request on whichever gateway is currently active, reconnecting once
// if the socket dropped. Projects are per-profile, so they intentionally follow
// the active gateway just like the session list does.
async function gatewayRequest<T>(method: string, params: Record<string, unknown> = {}): Promise<T> {
  let gateway = activeGateway()

  if (!gateway || gateway.connectionState !== 'open') {
    gateway = await ensureActiveGatewayOpen()
  }

  if (!gateway) {
    throw new Error('Hermes gateway is not connected')
  }

  return gateway.request<T>(method, params)
}

function applyPayload(payload: ProjectsPayload): void {
  $projects.set(payload.projects ?? [])
  $activeProjectId.set(payload.active_id ?? null)
  $projectsLoaded.set(true)
}

// Pull the full project list + active pointer. Best-effort: a failure (gateway
// not up yet) leaves the cached atoms intact so the sidebar doesn't flicker.
export async function refreshProjects(): Promise<void> {
  try {
    applyPayload(await gatewayRequest<ProjectsPayload>('projects.list'))
  } catch {
    // Backend may not be ready; keep the last known list.
  }
}

export interface CreateProjectInput {
  name: string
  folders?: string[]
  primaryPath?: string
  slug?: string
  description?: string
  icon?: string
  color?: string
  boardSlug?: string
  use?: boolean
}

export async function createProject(input: CreateProjectInput): Promise<ProjectInfo | null> {
  const res = await gatewayRequest<{ project: ProjectInfo | null }>('projects.create', {
    name: input.name,
    folders: input.folders ?? [],
    primary_path: input.primaryPath,
    slug: input.slug,
    description: input.description,
    icon: input.icon,
    color: input.color,
    board_slug: input.boardSlug,
    use: input.use ?? false
  })

  await refreshProjects()

  return res.project
}

export async function renameProject(id: string, name: string): Promise<void> {
  await gatewayRequest('projects.update', { id, name })
  await refreshProjects()
}

export async function updateProject(
  id: string,
  patch: { description?: string; icon?: string; color?: string; boardSlug?: string }
): Promise<void> {
  await gatewayRequest('projects.update', {
    id,
    description: patch.description,
    icon: patch.icon,
    color: patch.color,
    board_slug: patch.boardSlug
  })
  await refreshProjects()
}

export async function addProjectFolder(
  id: string,
  path: string,
  opts: { label?: string; isPrimary?: boolean } = {}
): Promise<void> {
  await gatewayRequest('projects.add_folder', {
    id,
    path,
    label: opts.label,
    is_primary: opts.isPrimary ?? false
  })
  await refreshProjects()
}

export async function removeProjectFolder(id: string, path: string): Promise<void> {
  await gatewayRequest('projects.remove_folder', { id, path })
  await refreshProjects()
}

export async function setProjectPrimary(id: string, path: string): Promise<void> {
  await gatewayRequest('projects.set_primary', { id, path })
  await refreshProjects()
}

export async function archiveProject(id: string, restore = false): Promise<void> {
  applyPayload(await gatewayRequest<ProjectsPayload>('projects.archive', { id, restore }))
}

export async function deleteProject(id: string): Promise<void> {
  applyPayload(await gatewayRequest<ProjectsPayload>('projects.delete', { id }))
}

export async function setActiveProject(id: null | string): Promise<void> {
  const res = await gatewayRequest<{ active_id: null | string }>('projects.set_active', { id })
  $activeProjectId.set(res.active_id ?? null)
}

// Resolve which project owns a path (longest-prefix folder match) + its branch.
export async function projectForCwd(
  cwd: string
): Promise<{ project: ProjectInfo | null; cwd: string; branch: string }> {
  return gatewayRequest('projects.for_cwd', { cwd })
}

// ── Project management dialog ────────────────────────────────────────────────
// A single dialog mounted in the sidebar reads this atom, so a project node's
// menu can open create / rename / add-folder flows without prop threading
// (mirrors $profileCreateRequest).
export interface ProjectDialogState {
  mode: 'add-folder' | 'create' | 'rename'
  projectId?: string
  name?: string
}

export const $projectDialog = atom<null | ProjectDialogState>(null)

export function openProjectCreate(): void {
  $projectDialog.set({ mode: 'create' })
}

export function openProjectRename(project: { id: string; name: string }): void {
  $projectDialog.set({ mode: 'rename', name: project.name, projectId: project.id })
}

export function openProjectAddFolder(project: { id: string; name: string }): void {
  $projectDialog.set({ mode: 'add-folder', name: project.name, projectId: project.id })
}

export function closeProjectDialog(): void {
  $projectDialog.set(null)
}

// ── Git-driven worktrees ("Start work") ─────────────────────────────────────
// Spin up a fresh worktree the lightest way (`git worktree add -b`) under the
// repo, returning where Hermes should start working. Git is the source of
// truth; the caller starts a session in the returned path.
export async function startWorkInRepo(
  repoPath: string,
  options?: { name?: string; branch?: string }
): Promise<null | { path: string; branch: string }> {
  const git = window.hermesDesktop?.git

  if (!git || !repoPath) {
    return null
  }

  const result = await git.worktreeAdd(repoPath, options)

  return { branch: result.branch, path: result.path }
}

export async function removeWorktreePath(repoPath: string, worktreePath: string): Promise<void> {
  const git = window.hermesDesktop?.git

  if (!git) {
    return
  }

  await git.worktreeRemove(repoPath, worktreePath)
}

// Reveal a project/worktree path in the OS file manager (git-GUI standard).
export async function revealPath(path: null | string): Promise<void> {
  if (path) {
    await window.hermesDesktop?.revealPath?.(path)
  }
}

// Copy a path to the clipboard (git-GUI standard).
export async function copyPath(path: null | string): Promise<void> {
  if (path) {
    await window.hermesDesktop?.writeClipboard?.(path)
  }
}

// Open the native directory picker (reuses the Electron default-project-dir
// chooser). Returns the chosen absolute path, or null when cancelled.
export async function pickProjectFolder(): Promise<null | string> {
  const pick = window.hermesDesktop?.settings?.pickDefaultProjectDir

  if (!pick) {
    return null
  }

  try {
    const result = await pick()

    return result.canceled ? null : result.dir
  } catch {
    return null
  }
}
