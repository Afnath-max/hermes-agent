import { describe, expect, it } from 'vitest'

import type { HermesWorktreeInfo } from '@/global'
import type { ProjectInfo, SessionInfo } from '@/types/hermes'

import {
  NO_PROJECT_ID,
  projectForPath,
  projectTreeFor,
  uniqueCwds,
  workspaceGroupsFor,
  workspaceTreeFor,
  type WorktreeResolver
} from './workspace-groups'

let nextId = 0

function makeSession(cwd: null | string, overrides: Partial<SessionInfo> = {}): SessionInfo {
  return {
    archived: false,
    cwd,
    ended_at: null,
    id: `s${nextId++}`,
    input_tokens: 0,
    is_active: false,
    last_active: 1_000,
    message_count: 1,
    model: 'claude',
    output_tokens: 0,
    preview: null,
    source: 'cli',
    started_at: 1_000,
    title: null,
    tool_call_count: 0,
    ...overrides
  }
}

const labels = (sessions: SessionInfo[]) => workspaceGroupsFor(sessions, 'No workspace').map(g => g.label)

describe('workspaceGroupsFor', () => {
  it('groups by full cwd, not by basename — same-named folders are separate groups', () => {
    const groups = workspaceGroupsFor(
      [makeSession('/a/hermes-agent/apps/desktop'), makeSession('/a/hermes-agent-wt-rtl/apps/desktop')],
      'No workspace'
    )

    expect(groups).toHaveLength(2)
  })

  it('disambiguates colliding basenames by walking up the path', () => {
    expect(
      labels([makeSession('/a/hermes-agent/apps/desktop'), makeSession('/a/hermes-agent-wt-rtl/apps/desktop')])
    ).toEqual(['hermes-agent/apps/desktop', 'hermes-agent-wt-rtl/apps/desktop'])
  })

  it('leaves a unique basename as its short label', () => {
    expect(labels([makeSession('/a/hermes-agent/apps/desktop'), makeSession('/b/heval-py')])).toEqual([
      'desktop',
      'heval-py'
    ])
  })

  it('grows the prefix past one segment when the parent also collides', () => {
    expect(labels([makeSession('/x/proj/apps/desktop'), makeSession('/y/proj/apps/desktop')])).toEqual([
      'x/proj/apps/desktop',
      'y/proj/apps/desktop'
    ])
  })

  it('keeps the synthetic no-workspace group untouched even if a real group shares its label', () => {
    const groups = workspaceGroupsFor([makeSession(null), makeSession('/a/No workspace')], 'No workspace')
    const noWorkspace = groups.find(g => g.path === null)

    expect(noWorkspace?.label).toBe('No workspace')
  })
})

const info = (over: Partial<HermesWorktreeInfo> & Pick<HermesWorktreeInfo, 'repoRoot' | 'worktreeRoot'>): HermesWorktreeInfo => ({
  branch: null,
  isMainWorktree: false,
  ...over
})

describe('workspaceTreeFor', () => {
  it('heuristic nests `<repo>-wt-<branch>` under its sibling repo', () => {
    const tree = workspaceTreeFor(
      [makeSession('/www/hermes-agent'), makeSession('/www/hermes-agent-wt-rtl')],
      'No workspace'
    )

    expect(tree).toHaveLength(1)
    expect(tree[0].label).toBe('hermes-agent')
    expect(tree[0].groups.map(g => g.label).sort()).toEqual(['hermes-agent', 'rtl'])
  })

  it('git metadata is authoritative — worktrees group by repoRoot regardless of directory naming', () => {
    const resolver: WorktreeResolver = cwd => {
      if (cwd === '/www/hermes-agent') {
        return info({ repoRoot: '/www/hermes-agent', worktreeRoot: '/www/hermes-agent', isMainWorktree: true, branch: 'main' })
      }

      if (cwd === '/elsewhere/ha-rtl') {
        return info({ repoRoot: '/www/hermes-agent', worktreeRoot: '/elsewhere/ha-rtl', branch: 'rtl' })
      }

      return null
    }

    const tree = workspaceTreeFor(
      [makeSession('/www/hermes-agent'), makeSession('/elsewhere/ha-rtl')],
      'No workspace',
      resolver
    )

    expect(tree).toHaveLength(1)
    expect(tree[0].label).toBe('hermes-agent')
    // The main checkout splits by each session's recorded branch; with no
    // recorded branch these collapse into the fallback "main" group. Linked
    // worktrees label by branch. Main-checkout group sorts ahead of linked.
    expect(tree[0].groups.map(g => g.label)).toEqual(['main', 'rtl'])
  })

  it('a standalone directory is its own parent (always parent → worktree → sessions)', () => {
    const tree = workspaceTreeFor([makeSession('/www/heval-node')], 'No workspace')

    expect(tree).toHaveLength(1)
    expect(tree[0].label).toBe('heval-node')
    expect(tree[0].groups).toHaveLength(1)
    expect(tree[0].groups[0].label).toBe('heval-node')
  })

  it('aggregates session counts across a repo’s worktrees', () => {
    const tree = workspaceTreeFor(
      [makeSession('/www/ha'), makeSession('/www/ha-wt-x'), makeSession('/www/ha-wt-x')],
      'No workspace'
    )

    const parent = tree.find(p => p.label === 'ha')

    expect(parent?.sessionCount).toBe(3)
  })

  it('no-workspace sessions form their own parent', () => {
    const tree = workspaceTreeFor([makeSession(null)], 'No workspace')

    expect(tree).toHaveLength(1)
    expect(tree[0].label).toBe('No workspace')
    expect(tree[0].path).toBeNull()
  })

  it('marks the main checkout isMain and linked worktrees not', () => {
    const tree = workspaceTreeFor([makeSession('/www/ha'), makeSession('/www/ha-wt-rtl')], 'No workspace')
    const parent = tree.find(p => p.label === 'ha')

    const main = parent?.groups.find(g => g.isMain)
    const linked = parent?.groups.find(g => !g.isMain)

    expect(main?.label).toBe('ha')
    expect(linked?.label).toBe('rtl')
  })

  it('splits main-checkout sessions into per-branch groups', () => {
    const resolver: WorktreeResolver = () =>
      info({ branch: 'whatever-is-checked-out-now', isMainWorktree: true, repoRoot: '/repo', worktreeRoot: '/repo' })

    const tree = workspaceTreeFor(
      [makeSession('/repo', { git_branch: 'main' }), makeSession('/repo', { git_branch: 'pets-feature' })],
      'No workspace',
      resolver
    )

    expect(tree).toHaveLength(1)
    // Grouped by the session's *recorded* branch, not the resolver's transient
    // current branch. Both live in the main checkout, so both are isMain.
    expect(tree[0].groups.map(g => g.label)).toEqual(['main', 'pets-feature'])
    expect(tree[0].groups.every(g => g.isMain)).toBe(true)
    expect(tree[0].sessionCount).toBe(2)
  })

  it('pins a trunk branch ahead of feature branches in the main checkout', () => {
    const resolver: WorktreeResolver = () =>
      info({ isMainWorktree: true, repoRoot: '/repo', worktreeRoot: '/repo' })

    const tree = workspaceTreeFor(
      [makeSession('/repo', { git_branch: 'aaa-feature' }), makeSession('/repo', { git_branch: 'main' })],
      'No workspace',
      resolver
    )

    expect(tree[0].groups.map(g => g.label)).toEqual(['main', 'aaa-feature'])
  })

  it('does NOT misattribute unrecorded sessions to the live current branch', () => {
    // The repo is currently on "currently-checked-out", but a legacy session
    // with no recorded branch must NOT be claimed by it — git can't prove an old
    // session ran on whatever happens to be checked out now.
    const resolver: WorktreeResolver = () =>
      info({ branch: 'currently-checked-out', isMainWorktree: true, repoRoot: '/repo', worktreeRoot: '/repo' })

    const tree = workspaceTreeFor([makeSession('/repo')], 'No workspace', resolver)

    expect(tree[0].groups.map(g => g.label)).toEqual(['main'])
  })

  it('prefers the recorded branch over the live git branch', () => {
    const resolver: WorktreeResolver = () =>
      info({ branch: 'currently-checked-out', isMainWorktree: true, repoRoot: '/repo', worktreeRoot: '/repo' })

    const tree = workspaceTreeFor([makeSession('/repo', { git_branch: 'when-it-ran' })], 'No workspace', resolver)

    expect(tree[0].groups.map(g => g.label)).toEqual(['when-it-ran'])
  })

  it('buckets branch-less main-checkout sessions under a single "main" group', () => {
    const resolver: WorktreeResolver = () =>
      info({ isMainWorktree: true, repoRoot: '/repo', worktreeRoot: '/repo' })

    const tree = workspaceTreeFor([makeSession('/repo'), makeSession('/repo')], 'No workspace', resolver)

    expect(tree[0].groups).toHaveLength(1)
    expect(tree[0].groups[0].label).toBe('main')
    expect(tree[0].groups[0].sessions).toHaveLength(2)
  })

  it('orders linked worktrees after main-checkout branches', () => {
    const resolver: WorktreeResolver = cwd =>
      cwd === '/repo'
        ? info({ isMainWorktree: true, repoRoot: '/repo', worktreeRoot: '/repo' })
        : info({ branch: 'feat', repoRoot: '/repo', worktreeRoot: '/wt/feat' })

    const tree = workspaceTreeFor(
      [makeSession('/wt/feat'), makeSession('/repo', { git_branch: 'main' })],
      'No workspace',
      resolver
    )

    expect(tree[0].groups.map(g => g.label)).toEqual(['main', 'feat'])
    expect(tree[0].groups.find(g => g.label === 'feat')?.isMain).toBe(false)
  })

  it('git metadata marks the main worktree isMain', () => {
    const resolver: WorktreeResolver = cwd => {
      if (cwd === '/repo') {
        return info({ repoRoot: '/repo', worktreeRoot: '/repo', isMainWorktree: true })
      }

      return info({ branch: 'feat', repoRoot: '/repo', worktreeRoot: '/wt/feat' })
    }

    const tree = workspaceTreeFor([makeSession('/repo'), makeSession('/wt/feat')], 'No workspace', resolver)
    const parent = tree[0]

    expect(parent.groups.find(g => g.isMain)?.path).toBe('/repo')
    expect(parent.groups.find(g => !g.isMain)?.label).toBe('feat')
  })
})

describe('uniqueCwds', () => {
  it('dedupes and drops empty/whitespace cwds', () => {
    expect(uniqueCwds([makeSession('/a'), makeSession('/a'), makeSession(null), makeSession('   ')])).toEqual(['/a'])
  })
})

let nextProjectId = 0

function makeProject(name: string, folders: string[], over: Partial<ProjectInfo> = {}): ProjectInfo {
  return {
    id: `p${nextProjectId++}`,
    slug: name.toLowerCase().replace(/\s+/g, '-'),
    name,
    description: null,
    icon: null,
    color: null,
    board_slug: null,
    primary_path: folders[0] ?? null,
    archived: false,
    created_at: 1_000,
    folders: folders.map((path, index) => ({ path, label: null, is_primary: index === 0, added_at: 1_000 })),
    ...over
  }
}

describe('projectForPath', () => {
  it('matches a session cwd nested under a project folder', () => {
    const project = makeProject('App', ['/www/app'])

    expect(projectForPath([project], '/www/app/src/index.ts')?.slug).toBe('app')
  })

  it('returns null when no folder is a prefix', () => {
    expect(projectForPath([makeProject('App', ['/www/app'])], '/other/place')).toBeNull()
  })

  it('uses the longest-prefix (innermost) project for nested projects', () => {
    const outer = makeProject('Outer', ['/www'])
    const inner = makeProject('Inner', ['/www/app'])

    expect(projectForPath([outer, inner], '/www/app/src')?.slug).toBe('inner')
  })

  it('does not match a sibling whose name is a string-prefix but not a path-prefix', () => {
    const project = makeProject('App', ['/www/app'])

    // /www/app-extra must NOT match /www/app (segment-wise prefix only).
    expect(projectForPath([project], '/www/app-extra/src')).toBeNull()
  })

  it('skips archived projects', () => {
    const project = makeProject('App', ['/www/app'], { archived: true })

    expect(projectForPath([project], '/www/app/src')).toBeNull()
  })
})

describe('projectTreeFor', () => {
  it('buckets sessions under their owning project and keeps the repo subtree', () => {
    const project = makeProject('App', ['/www/app'])
    const tree = projectTreeFor([makeSession('/www/app')], [project], 'No workspace')

    expect(tree).toHaveLength(1)
    expect(tree[0].label).toBe('App')
    expect(tree[0].sessionCount).toBe(1)
    expect(tree[0].repos).toHaveLength(1)
  })

  it('renders an empty project with zero sessions (no repos)', () => {
    const project = makeProject('Empty', ['/www/empty'])
    const tree = projectTreeFor([], [project], 'No workspace')

    expect(tree).toHaveLength(1)
    expect(tree[0].sessionCount).toBe(0)
    expect(tree[0].repos).toHaveLength(0)
  })

  it('promotes unowned git repos to auto-projects and omits cwd-less sessions', () => {
    const project = makeProject('App', ['/www/app'])

    const tree = projectTreeFor([makeSession('/www/app'), makeSession('/elsewhere/thing'), makeSession(null)], [project], 'No workspace')

    // Explicit project keeps its owned session.
    expect(tree.find(node => node.label === 'App')?.sessionCount).toBe(1)
    // The unowned dir became its own auto-project.
    const auto = tree.find(node => node.isAuto)
    expect(auto?.label).toBe('thing')
    expect(auto?.sessionCount).toBe(1)
    // The cwd-less session is dropped entirely — there is no "No project" bucket.
    expect(tree.some(node => node.id === NO_PROJECT_ID)).toBe(false)
    expect(tree.some(node => node.isNoProject)).toBe(false)
  })

  it('never emits a No-project bucket even when only cwd-less sessions exist', () => {
    const tree = projectTreeFor([makeSession(null), makeSession(null)], [], 'No workspace')

    expect(tree).toHaveLength(0)
  })

  it('auto-projects appear with no explicit projects at all', () => {
    const tree = projectTreeFor([makeSession('/www/repo-a'), makeSession('/www/repo-b')], [], 'No workspace')

    expect(tree).toHaveLength(2)
    expect(tree.every(node => node.isAuto)).toBe(true)
    expect(tree.map(node => node.label).sort()).toEqual(['repo-a', 'repo-b'])
  })

  it('explicit projects sort ahead of auto-projects', () => {
    const project = makeProject('App', ['/www/app'])
    const tree = projectTreeFor([makeSession('/www/app'), makeSession('/www/other')], [project], 'No workspace')

    expect(tree[0].label).toBe('App')
    expect(tree[0].isAuto).toBeFalsy()
    expect(tree[1].isAuto).toBe(true)
  })
})
