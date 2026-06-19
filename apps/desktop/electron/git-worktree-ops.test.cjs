'use strict'

const assert = require('node:assert/strict')
const test = require('node:test')

const { parseWorktrees } = require('./git-worktree-ops.cjs')

test('parseWorktrees: main checkout + linked worktree', () => {
  const out = [
    'worktree /repo',
    'HEAD abc123',
    'branch refs/heads/main',
    '',
    'worktree /repo/.worktrees/feat',
    'HEAD def456',
    'branch refs/heads/hermes/feat',
    ''
  ].join('\n')

  const trees = parseWorktrees(out)

  assert.equal(trees.length, 2)
  assert.equal(trees[0].path, '/repo')
  assert.equal(trees[0].branch, 'main')
  assert.equal(trees[1].path, '/repo/.worktrees/feat')
  assert.equal(trees[1].branch, 'hermes/feat')
})

test('parseWorktrees: detached + locked flags', () => {
  const out = ['worktree /repo/wt', 'HEAD abc', 'detached', 'locked reason', ''].join('\n')
  const trees = parseWorktrees(out)

  assert.equal(trees.length, 1)
  assert.equal(trees[0].detached, true)
  assert.equal(trees[0].locked, true)
  assert.equal(trees[0].branch, null)
})

test('parseWorktrees: empty input', () => {
  assert.deepEqual(parseWorktrees(''), [])
})
