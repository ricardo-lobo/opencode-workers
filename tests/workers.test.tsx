import { describe, expect, mock, test } from 'claude-code/testing'

import {
  applyLine,
  argvFor,
  isInside,
  isPlainName,
  normalizePath,
  patternsOf,
  permissionsFor,
  resumeCommand,
  workerConfig,
  writeDiff,
} from '../hooks/register'
import type { Worker } from '../types'

const CWD = '/repo'
const base: Worker = {
  id: 'w1', sessionID: null, title: 'probe', model: 'm', agent: '', cwd: CWD, prompt: 'p',
  followUps: [], status: 'running', startedAt: 0, endedAt: null, steps: 0, cost: 0, tokensIn: 0,
  tokensOut: 0, files: [], changes: [], events: [], finalText: '', error: null,
}

const EDIT_PATCH = 'Index: a.txt\n===\n--- a.txt\n+++ a.txt\n@@ -1,3 +1,3 @@\n line one\n-line two\n+line 2\n line three\n'

const LINES = [
  { type: 'step_start', sessionID: 'ses_1', part: { type: 'step-start' } },
  { type: 'tool_use', sessionID: 'ses_1', part: { type: 'tool', tool: 'read', state: { status: 'completed', input: { path: '/repo/a.txt' } } } },
  { type: 'step_finish', sessionID: 'ses_1', part: { type: 'step-finish', cost: 0.001, tokens: { input: 100, output: 10 } } },
  {
    type: 'tool_use', sessionID: 'ses_1',
    part: {
      type: 'tool', tool: 'edit',
      state: {
        status: 'completed', input: { path: '/repo/a.txt', oldString: 'line two', newString: 'line 2' },
        metadata: { metadata: { files: [{ file: 'a.txt', patch: EDIT_PATCH, status: 'modified', additions: 1, deletions: 1 }] } },
      },
    },
  },
  { type: 'tool_use', sessionID: 'ses_1', part: { type: 'tool', tool: 'write', state: { status: 'completed', input: { path: '/repo/b.txt', content: 'X\nY\n' }, output: 'Created file successfully: b.txt' } } },
  { type: 'tool_use', sessionID: 'ses_1', part: { type: 'tool', tool: 'bash', state: { status: 'error', input: { command: 'npm test' }, error: 'exit 1' } } },
  { type: 'text', sessionID: 'ses_1', part: { type: 'text', text: 'DONE' } },
].map(l => JSON.stringify(l))

describe('applyLine', () => {
  test('folds opencode json events into the worker', async () => {
    const w = LINES.reduce((acc, l) => applyLine(acc, l, 1), base)
    expect(w.sessionID).toBe('ses_1')
    expect(w.steps).toBe(1)
    expect(w.cost).toBe(0.001)
    expect(w.tokensIn).toBe(100)
    expect(w.files).toEqual(['a.txt', 'b.txt'])
    expect(w.finalText).toBe('DONE')
    expect(w.events.map(e => e.kind)).toEqual(['tool', 'tool', 'tool', 'error', 'text'])
    expect(w.events[0]?.label).toBe('read a.txt')
  })

  test('keeps edit hunks and builds a new-file diff for writes', async () => {
    const w = LINES.reduce((acc, l) => applyLine(acc, l, 1), base)
    const [edit, write] = w.changes
    expect(edit).toMatchObject({ file: 'a.txt', status: 'modified', additions: 1, deletions: 1 })
    expect(edit?.patch.startsWith('@@ -1,3 +1,3 @@')).toBe(true)
    expect(write).toMatchObject({ file: 'b.txt', status: 'added' })
    expect(write?.patch).toBe(writeDiff('X\nY\n'))
    expect(writeDiff('X\nY\n')).toBe('@@ -0,0 +1,2 @@\n+X\n+Y\n')
  })

  test('two edits to one file add up', async () => {
    const edit = LINES[3]!
    const w = [edit, edit].reduce((acc, l) => applyLine(acc, l, 1), base)
    expect(w.changes).toHaveLength(1)
    expect(w.changes[0]).toMatchObject({ additions: 2, deletions: 2 })
  })

  test('ignores lines that are not json', async () => {
    expect(applyLine(base, 'not json', 1)).toBe(base)
  })

  test('ignores a session id that is not opencode-shaped', async () => {
    const line = JSON.stringify({ type: 'step_start', sessionID: 'ses_1; rm -rf ~', part: {} })
    expect(applyLine(base, line, 1).sessionID).toBeNull()
  })
})

describe('guards', () => {
  test('a prompt or title that looks like a flag stays text', async () => {
    const argv = argvFor({ ...base, title: '--agent x' }, '-m evil/model')
    expect(argv).toEqual(expect.arrayContaining(['--standalone', '--auto', '--', '-m evil/model']))
    expect(argv.at(-2)).toBe('--')
    expect(argv[argv.indexOf('--title') + 1]).toBe('agent x')
  })

  test('model and agent names must not be flags', async () => {
    expect(isPlainName('opencode-go/deepseek-v4.1-flash')).toBe(true)
    expect(isPlainName('')).toBe(true)
    expect(isPlainName('--standalone')).toBe(false)
    expect(isPlainName('plan --x')).toBe(false)
  })

  test('paths resolve before the folder check', async () => {
    expect(normalizePath('/repo/./src/../../etc')).toBe('/etc')
    expect(isInside(normalizePath('/repo/sub/..'), '/repo')).toBe(true)
    expect(isInside('/repository', '/repo')).toBe(false)
  })

  test('the resume command quotes the folder for the shell', async () => {
    expect(resumeCommand({ cwd: "/tmp/$(touch x)/it's", sessionID: 'ses_1' })).toBe(
      `cd '/tmp/$(touch x)/it'\\''s' && opencode -s ses_1`,
    )
  })

  test('the rules deny pushes, deletes and .env files', async () => {
    const rules = permissionsFor([])
    expect(rules.external_directory).toBe('deny')
    expect(rules.bash).toMatchObject({ 'git push*': 'deny', 'rm *': 'deny', '* .env*': 'deny' })
    expect(rules.read['*.env']).toBe('deny')
    expect(rules.edit).toMatchObject({ '*.git/*': 'deny', '*.git': 'deny', '*.claude/*': 'deny', '*opencode.json': 'deny' })
    expect(rules.bash).toMatchObject({ '*.git/*': 'deny', '*opencode.json*': 'deny', '*CLAUDE.md*': 'deny' })
    expect(rules.edit).toMatchObject({ '*.mcp.json': 'deny', '*AGENTS.md': 'deny', '*lefthook.yml': 'deny' })
  })

  test('the stack adds its own commands', async () => {
    expect(patternsOf(' *artisan migrate*, ,*rails db:* ')).toEqual(['*artisan migrate*', '*rails db:*'])
    expect(patternsOf('')).toEqual([])
    expect(permissionsFor(['*rails db:*']).bash).toMatchObject({ '*rails db:*': 'deny', 'git push*': 'deny' })
    expect(permissionsFor([]).bash).not.toHaveProperty('*artisan migrate*')
  })

  test('every agent carries the rules, and project subagents are refused', async () => {
    const config = workerConfig(['*rails db:*'], 'reviewer')
    expect(Object.keys(config.agent)).toEqual(['build', 'plan', 'general', 'explore', 'reviewer'])
    expect(config.agent.reviewer?.permission).toEqual(permissionsFor(['*rails db:*']))
    expect(config.permission.task).toEqual({ '*': 'deny', general: 'allow', explore: 'allow' })
    expect(Object.keys(workerConfig([], 'plan').agent)).toHaveLength(4)
  })
})

const PANE = {
  component: 'Pane' as const,
  requestId: 'opencode-workers',
  props: { title: 'opencode', isFocused: false, bodyColumns: 80, placement: 'dock' as const },
}

const settle = async (pending: Promise<unknown>, clock: { advance: (ms: number) => Promise<unknown> }) => {
  let isSettled = false
  void pending.then(() => (isSettled = true))
  for (let i = 0; i < 30 && !isSettled; i++) await clock.advance(1_000)
  return pending
}

const OPTIONS = { extraDeniedCommands: '*rails db:*, *prisma migrate*' }

test('delegate, follow-up and the pane on every surface', { options: OPTIONS }, async ($, on) => {
  const clock = mock.clock(on, { now: 1_000 })
  on('ui.open', () => ({ value: { isPlaced: true } }) as never)
  on('ui.toast', () => ({ value: undefined }) as never)
  let panes: { id: string }[] = []
  on('ui.panes', () => ({ value: panes }) as never)
  on('ui.render', { component: 'AbovePrompt' }, ($, e) => {
    const { Box } = $.ui.resolve(e)
    return <Box key="engine-band" />
  })
  on('process.run', async (_$, e) => {
    // pwd stands for the file system: /repo/link is a symlink to /etc
    const cwd = e.init?.cwd ?? ''
    const physical = cwd === `${CWD}/link` ? '/etc' : cwd
    const stdout =
      e.argv[0] === 'git' ? `worktree ${CWD}\nHEAD abc\n` : e.argv[0] === '/bin/pwd' ? `${physical}\n` : ''
    if (e.argv[0] === '/bin/sleep') await clock.advance(1_000)
    return { value: { exitCode: 0, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } } as never
  })
  const envs: (Record<string, string> | undefined)[] = []
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('command.register', () => ({ value: { command: 'opencode' } }) as never)
  on('tool.register', () => ({ value: undefined }) as never)
  const spawned: string[][] = []
  on('process.spawn', async function* (_$, e) {
    spawned.push([...e.argv])
    envs.push(e.env)
    const lines = spawned.length === 1 ? LINES : [JSON.stringify({ type: 'text', sessionID: 'ses_1', part: { type: 'text', text: 'FIXED' } })]
    for (const line of lines) yield { stream: 'stdout' as const, text: `${line}\n` }
    return { value: { code: 0, signal: null } } as never
  })

  // the session folder is elsewhere: /repo is allowed as one of its git worktrees
  await $.session.start({ cwd: '/home/me', surface: 'terminal', isInteractive: true })
  const outside = await $.tool.call({ tool: 'mcp__opencode-workers__delegate', prompt: 'do it', cwd: `${CWD}/../etc` } as never)
  expect(String((outside as { deny?: unknown }).deny)).toContain('outside the session folder')
  const linked = await $.tool.call({ tool: 'mcp__opencode-workers__delegate', prompt: 'do it', cwd: `${CWD}/link` } as never)
  expect(String((linked as { deny?: unknown }).deny)).toContain('outside the session folder')
  const flag = await $.tool.call({ tool: 'mcp__opencode-workers__delegate', prompt: 'do it', cwd: CWD, model: '--x' } as never)
  expect(String((flag as { deny?: unknown }).deny)).toContain('plain names')
  expect(spawned).toHaveLength(0)

  const started = await $.tool.call({ tool: 'mcp__opencode-workers__delegate', prompt: 'do it', title: 'probe', cwd: CWD } as never)
  expect(String(started.result)).toContain('w1')
  await clock.advance(0)
  expect(JSON.parse(envs[0]?.OPENCODE_CONFIG_CONTENT ?? '{}')).toEqual(
    workerConfig(['*rails db:*', '*prisma migrate*'], ''),
  )

  const status = await settle($.tool.call({ tool: 'mcp__opencode-workers__status', id: 'w1', wait_seconds: 30 } as never), clock)
  const text = String((status as { result: unknown }).result)
  expect(text).toContain('[done]')
  expect(text).toContain('M a.txt +1/-1')
  expect(text).toContain('A b.txt')

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ plugin: 'opencode-workers', surface, ...PANE } as never)
    expect(await ui.find({ key: 'card-w1' })).toBeDefined()
    expect(await ui.find({ key: 'diff-a.txt' })).toBeDefined()
    expect(await ui.find({ key: 'copy-resume' })).toBeDefined()
    expect(await ui.find({ key: 'repeat' })).toBeDefined()
    expect(await ui.find({ key: 'follow-up-w1' })).toBeDefined()
    expect(await ui.find({ key: 'stop' })).toBeUndefined()
    await ui.press({ key: 'toggle-diffs' })
    expect(await ui.find({ key: 'diff-a.txt' })).toBeUndefined()
    await ui.press({ key: 'toggle-diffs' })
    await ui.unmount()
  }

  const sent = await $.tool.call({ tool: 'mcp__opencode-workers__follow_up', id: 'w1', prompt: 'fix it' } as never)
  expect(String(sent.result)).toContain('Sent a follow-up to w1')
  const again = await settle($.tool.call({ tool: 'mcp__opencode-workers__status', id: 'w1', wait_seconds: 30 } as never), clock)
  expect(String((again as { result: unknown }).result)).toContain('FIXED')
  expect(spawned[1]).toEqual(expect.arrayContaining(['-s', 'ses_1', 'fix it']))
  expect(spawned[1]).not.toContain('--title')

  for (const surface of ['terminal', 'desktop'] as const) {
    const band = await $.ui.mount({ plugin: 'opencode-workers', surface, component: 'AbovePrompt', props: { hasSurvey: false } } as never)
    expect(await band.find({ key: 'open-pane' })).toBeDefined()
    panes = [{ id: 'opencode-workers' }]
    await band.redraw()
    expect(await band.find({ key: 'open-pane' })).toBeUndefined()
    panes = []
    await band.unmount()
  }

  const ui = await $.ui.mount({ plugin: 'opencode-workers', surface: 'desktop', ...PANE } as never)
  await ui.press({ key: 'clear' })
  expect(await ui.find({ text: /No opencode workers yet/ })).toBeDefined()
  await ui.unmount()
})
