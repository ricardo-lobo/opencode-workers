import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { FileChange, Worker, WorkerEvent } from '../types'

const PANE = 'opencode-workers'
const EVENT_CAP = 200
const PATCH_CAP = 30_000
const DIFF_LINES_SHOWN = 120
const SESSION_ID = /^ses_[A-Za-z0-9]+$/

/**
 * Shell commands a worker may never run. `--auto` approves everything that is
 * not explicitly denied, and opencode checks each command of a `&&` chain.
 */
export const DENIED_COMMANDS = [
  'git push*', 'git commit*', 'git reset*', 'git checkout*', 'git switch*', 'git restore*', 'git stash*',
  'git rebase*', 'git merge*', 'git clean*', 'git branch -d*', 'git branch -D*', 'git tag*', 'git remote*',
  'git config*', 'git -C*', 'git -c*', 'gh *', 'glab *',
  // shells and wrappers that would hide a command from the patterns
  'sh -c*', 'bash -c*', 'zsh -c*', 'xargs *', 'env *', 'command *',
  'rm *', '*/rm *', '*find * -delete*', 'sudo *', 'ssh *', 'scp *', 'rsync *', 'kill *', 'pkill *', 'killall *',
  'composer require*', 'composer install*', 'composer update*', 'composer remove*',
  'npm install*', 'npm i', 'npm i *', 'npm uninstall*', 'npm update*', 'npm publish*',
  'pnpm add*', 'pnpm install*', 'pnpm i', 'pnpm i *', 'pnpm remove*', 'pnpm update*',
  'yarn', 'yarn add*', 'yarn install*', 'yarn remove*', 'bun add*', 'bun install*', 'bun remove*', 'bun update*',
  'pip install*', 'pip uninstall*', 'pip3 install*', 'uv add*', 'uv remove*', 'uv pip install*',
  'poetry add*', 'poetry install*', 'poetry remove*',
  'cargo add*', 'cargo install*', 'cargo remove*', 'cargo publish*', 'go get*', 'go install*',
  'gem install*', 'bundle add*', 'bundle install*', 'brew *',
  '* .env*', '*/.env*', '*<.env*',
]

/**
 * Paths whose contents run later, outside the worker (git hooks, Claude Code
 * and editor settings, CI, opencode's own config): no worker may write them.
 */
export const PROTECTED_PATHS = [
  '*.git/*', '*.claude/*', '*.opencode/*', '*.husky/*', '*.vscode/*', '*.idea/*', '*.github/workflows/*',
  // a worktree's .git is a file naming its gitdir: repointed, it brings its own hooks
  '*.git', '*.gitmodules', '*opencode.json', '*opencode.jsonc', '*.envrc',
  '*.pre-commit-config.yaml', '*lefthook.yml', '*lefthook.yaml',
  // what Claude and later workers read as instructions or servers
  '*.mcp.json', '*.claude.json', '*CLAUDE.md', '*CLAUDE.local.md', '*AGENTS.md',
]

/**
 * The opencode permission rules every worker runs under, passed inline so they
 * win over the user's and the project's own config. `extraDenied` holds the
 * stack's own commands, from the `extraDeniedCommands` option.
 */
export const permissionsFor = (extraDenied: readonly string[]) => ({
  external_directory: 'deny',
  read: { '*.env': 'deny', '*.env.*': 'deny', '*.env.example': 'allow' },
  edit: {
    '*.env': 'deny',
    '*.env.*': 'deny',
    '*.env.example': 'allow',
    ...Object.fromEntries(PROTECTED_PATHS.map(p => [p, 'deny'])),
  },
  bash: Object.fromEntries(
    [...DENIED_COMMANDS, ...PROTECTED_PATHS.map(p => (p.endsWith('*') ? p : `${p}*`)), ...extraDenied].map(c => [
      c,
      'deny',
    ]),
  ),
})

const BUILT_IN_AGENTS = ['build', 'plan', 'general', 'explore']

/**
 * The inline opencode config of a worker. An agent's own permissions win over
 * the top-level ones, so the rules are repeated on every built-in agent and on
 * the chosen one; subagents a project defines are refused outright.
 */
export const workerConfig = (extraDenied: readonly string[], agent: string) => {
  const rules = permissionsFor(extraDenied)
  const agents = [...new Set([...BUILT_IN_AGENTS, agent].filter(Boolean))]
  return {
    permission: { ...rules, task: { '*': 'deny', general: 'allow', explore: 'allow' } },
    agent: Object.fromEntries(agents.map(a => [a, { permission: rules }])),
  }
}

/** The patterns of a comma-separated option value. */
export const patternsOf = (value: string) =>
  value
    .split(',')
    .map(p => p.trim())
    .filter(Boolean)

const workers = atom({ plugin: 'opencode-workers', key: 'workers' } as const, [])
const selected = atom({ plugin: 'opencode-workers', key: 'selected' } as const, null)
const seq = atom({ plugin: 'opencode-workers', key: 'seq' } as const, 0)
const showDiffs = atom({ plugin: 'opencode-workers', key: 'showDiffs' } as const, true)

type $ = EngineInterface
type Stream = ReturnType<$['process']['spawn']>

const str = (v: unknown) => (typeof v === 'string' ? v : '')
const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : 0)
const obj = (v: unknown): Record<string, unknown> =>
  v !== null && typeof v === 'object' ? (v as Record<string, unknown>) : {}
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : [])
const cut = (text: string, max: number) =>
  text.length > max ? `${text.slice(0, max - 1)}…` : text
const oneLine = (text: string) => text.replace(/\s+/g, ' ').trim()

const relative = (path: string, cwd: string) =>
  cwd && path.startsWith(`${cwd}/`) ? path.slice(cwd.length + 1) : path

const shortModel = (model: string) => model.split('/').pop() ?? model

/** An absolute path with `.`, `..` and repeated slashes resolved (symlinks are not). */
export const normalizePath = (path: string) => {
  const parts: string[] = []
  for (const part of path.split('/')) {
    if (part === '' || part === '.') continue
    if (part === '..') parts.pop()
    else parts.push(part)
  }
  return `/${parts.join('/')}`
}

export const isInside = (path: string, root: string) => root === '/' || path === root || path.startsWith(`${root}/`)

/** A model or agent name that opencode's parser cannot mistake for a flag. */
export const isPlainName = (value: string) => value === '' || /^[^-\s]\S*$/.test(value)

const shellQuote = (text: string) => `'${text.split("'").join(`'\\''`)}'`

export const resumeCommand = (w: Pick<Worker, 'cwd' | 'sessionID'>) =>
  `cd ${shellQuote(w.cwd)} && opencode -s ${w.sessionID}`

/** The `opencode run` command for one run of the worker: its first prompt, or a follow-up. */
export const argvFor = (w: Pick<Worker, 'model' | 'sessionID' | 'title' | 'agent'>, message: string) => {
  // --standalone: the background service would not see this process's env, and so not the rules
  const argv = ['opencode', 'run', '--standalone', '--format', 'json', '--auto', '-m', w.model]
  if (w.sessionID) argv.push('-s', w.sessionID)
  else argv.push('--title', w.title.replace(/^[-\s]+/, '') || 'opencode worker')
  if (w.agent) argv.push('--agent', w.agent)
  argv.push('--', message)
  return argv
}

const duration = (w: Worker, now: number) => {
  const s = Math.max(0, Math.round(((w.endedAt ?? now) - w.startedAt) / 1000))
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m${String(s % 60).padStart(2, '0')}s`
}

const statusLabel: Record<Worker['status'], string> = {
  running: '● running',
  done: '✓ done',
  failed: '✗ failed',
  stopped: '■ stopped',
  interrupted: '! interrupted',
}

const statusColor: Record<Worker['status'], string> = {
  running: 'suggestion',
  done: 'success',
  failed: 'error',
  stopped: 'warning',
  interrupted: 'warning',
}

const changeMark: Record<FileChange['status'], string> = { added: 'A', modified: 'M', rewritten: 'W' }

/** The hunks of a unified diff, its file headers dropped. */
export const hunksOf = (patch: string) => {
  const at = patch.indexOf('@@')
  return at < 0 ? '' : patch.slice(at)
}

/** A whole-file diff for content written in one go (opencode's write tool). */
export const writeDiff = (content: string) => {
  const lines = content.endsWith('\n') ? content.slice(0, -1).split('\n') : content.split('\n')
  return `@@ -0,0 +1,${lines.length} @@\n${lines.map(l => `+${l}`).join('\n')}\n`
}

const addChange = (changes: FileChange[], next: FileChange): FileChange[] => {
  const prev = changes.find(c => c.file === next.file)
  if (!prev) return [...changes, { ...next, patch: next.patch.slice(0, PATCH_CAP) }]
  const merged: FileChange =
    next.status === 'modified'
      ? {
          ...prev,
          additions: prev.additions + next.additions,
          deletions: prev.deletions + next.deletions,
          patch: (prev.patch + next.patch).slice(0, PATCH_CAP),
        }
      : { ...next, status: prev.status === 'added' ? 'added' : next.status, patch: next.patch.slice(0, PATCH_CAP) }
  return changes.map(c => (c.file === next.file ? merged : c))
}

/** One opencode tool_use part: a short line, and the file change it made, if any. */
export const describeTool = (part: Record<string, unknown>, cwd: string) => {
  const tool = str(part.tool) || 'tool'
  const state = obj(part.state)
  const input = obj(state.input)
  const target =
    str(input.path) ||
    str(input.filePath) ||
    str(input.file_path) ||
    str(input.command) ||
    str(input.pattern) ||
    str(input.url) ||
    str(input.query) ||
    str(state.title)
  const label = cut(oneLine(`${tool} ${relative(target, cwd)}`), 160)
  const isError = str(state.status) === 'error'
  const path = str(input.path) || str(input.filePath) || str(input.file_path)
  const changes: FileChange[] = []

  if (!isError) {
    // edit / patch tools carry real unified diffs in their metadata
    for (const f of arr(obj(obj(state.metadata).metadata).files)) {
      const one = obj(f)
      const file = relative(str(one.file) || path, cwd)
      const patch = hunksOf(str(one.patch))
      if (!file || !patch) continue
      changes.push({
        file,
        status: str(one.status) === 'added' ? 'added' : 'modified',
        additions: num(one.additions),
        deletions: num(one.deletions),
        patch,
      })
    }
    if (changes.length === 0 && tool === 'write' && path) {
      const content = str(input.content)
      const isNew = /created/i.test(str(state.output))
      changes.push({
        file: relative(path, cwd),
        status: isNew ? 'added' : 'rewritten',
        additions: content ? content.split('\n').length : 0,
        deletions: 0,
        patch: writeDiff(content),
      })
    }
  }

  return { label, changes, isError, error: isError ? str(state.error) : '' }
}

/** Folds one line of `opencode run --format json` into the worker. */
export const applyLine = (w: Worker, line: string, at: number): Worker => {
  let ev: Record<string, unknown>
  try {
    ev = obj(JSON.parse(line))
  } catch {
    return w
  }
  const part = obj(ev.part)
  const sessionID = w.sessionID ?? (SESSION_ID.test(str(ev.sessionID)) ? str(ev.sessionID) : null)
  const push = (e: WorkerEvent) => [...w.events, e].slice(-EVENT_CAP)

  switch (str(ev.type)) {
    case 'step_start':
      return { ...w, sessionID, steps: w.steps + 1 }
    case 'step_finish': {
      const tokens = obj(part.tokens)
      return {
        ...w,
        sessionID,
        cost: w.cost + num(part.cost),
        tokensIn: w.tokensIn + num(tokens.input),
        tokensOut: w.tokensOut + num(tokens.output),
      }
    }
    case 'tool_use': {
      const t = describeTool(part, w.cwd)
      const changes = t.changes.reduce(addChange, w.changes)
      const files = changes.map(c => c.file)
      const label = t.isError ? `${t.label} — ${cut(oneLine(t.error), 120)}` : t.label
      return { ...w, sessionID, files, changes, events: push({ at, kind: t.isError ? 'error' : 'tool', label }) }
    }
    case 'text': {
      const text = str(part.text)
      if (!text.trim()) return { ...w, sessionID }
      return {
        ...w,
        sessionID,
        finalText: text,
        events: push({ at, kind: 'text', label: cut(oneLine(text), 160) }),
      }
    }
    case 'error': {
      const err = obj(ev.error)
      const message = str(obj(err.data).message) || str(err.message) || str(err.name) || line
      return { ...w, sessionID, error: message, events: push({ at, kind: 'error', label: cut(oneLine(message), 200) }) }
    }
    default:
      return { ...w, sessionID }
  }
}

const report = (w: Worker, now: number, full: boolean) => {
  const delta = w.changes.reduce((s, c) => [s[0]! + c.additions, s[1]! + c.deletions], [0, 0])
  const head = `${w.id} [${w.status}] "${w.title}" — ${w.model}, ${duration(w, now)}, ${w.steps} steps, +${delta[0]}/-${delta[1]}, $${w.cost.toFixed(4)}`
  if (!full) return head
  const lines = [
    head,
    `cwd: ${w.cwd}`,
    w.sessionID ? `opencode session: ${w.sessionID} (resume: ${resumeCommand(w)})` : '',
    `files changed: ${w.changes.length ? w.changes.map(c => `${changeMark[c.status]} ${c.file} +${c.additions}/-${c.deletions}`).join(', ') : 'none'}`,
    w.followUps.length ? `follow-ups sent: ${w.followUps.length}` : '',
    w.error ? `error: ${w.error}` : '',
    '',
    'recent activity:',
    ...w.events.slice(-15).map(e => `  ${e.kind === 'error' ? '✗' : e.kind === 'prompt' ? '»' : '-'} ${e.label}`),
    '',
    w.status === 'running' ? '(still running — final answer not yet available)' : 'final answer:',
    w.status === 'running' ? '' : w.finalText || '(no text answer)',
  ]
  return lines.filter(l => l !== '').join('\n')
}

const streams = new Map<string, Stream>()
let ticker: { cancel: () => void } | null = null
let sessionCwd = ''
let defaultModel = 'opencode-go/deepseek-v4.1-flash'
let extraDenied: string[] = []

// The workers this module started, as they stand now. The atom is what the
// pane draws; this map is what a status wait reads, so it never depends on
// when another dispatch's state writes become visible.
const live = new Map<string, Worker>()

function patch($: $, id: string, fn: (w: Worker) => Worker) {
  const cur = live.get(id)
  if (cur) live.set(id, fn(cur))
  return update($, workers, list => list.map(w => (w.id === id ? (live.get(id) ?? fn(w)) : w)))
}

async function snapshot($: $) {
  const list = await read($, workers)
  return list.map(w => live.get(w.id) ?? w)
}

function ensureTicker($: $) {
  if (ticker) return
  ticker = $.clock.every(1000, () => {
    if (streams.size === 0) {
      ticker?.cancel()
      ticker = null
    }
    $.ui.invalidate('ui.render')
  })
}

/** Runs one `opencode run` for the worker: its first prompt, or a follow-up in its session. */
async function run($: $, id: string, message: string) {
  const w = live.get(id)
  if (!w) return
  const stream = $.process.spawn({
    argv: argvFor(w, message),
    cwd: w.cwd || undefined,
    env: { OPENCODE_CONFIG_CONTENT: JSON.stringify(workerConfig(extraDenied, w.agent)) },
  })
  streams.set(id, stream)
  ensureTicker($)
  let buffer = ''
  let stderr = ''
  try {
    for await (const { stream: pipe, text } of stream) {
      if (pipe === 'stderr') {
        stderr = (stderr + text).slice(-4000)
        continue
      }
      buffer += text
      const lines = buffer.split('\n')
      buffer = lines.pop() ?? ''
      const at = await $.clock.now()
      const complete = lines.filter(l => l.trim())
      if (complete.length) await patch($, id, cur => complete.reduce((acc, l) => applyLine(acc, l, at), cur))
    }
    const ended = await stream.result
    const at = await $.clock.now()
    await patch($, id, cur => {
      const withTail = buffer.trim() ? applyLine(cur, buffer, at) : cur
      if (withTail.status !== 'running') return { ...withTail, endedAt: withTail.endedAt ?? at }
      const ok = ended.code === 0 && !withTail.error
      return {
        ...withTail,
        status: ok ? 'done' : 'failed',
        endedAt: at,
        error: ok ? null : withTail.error ?? (oneLine(stderr).slice(-600) || `exit ${ended.code ?? ended.signal}`),
      }
    })
    const final = live.get(id)
    if (final) $.ui.toast(`opencode ${final.id} ${final.status}: ${cut(final.title, 60)}`)
  } catch (err) {
    const at = await $.clock.now()
    await patch($, id, cur =>
      cur.status === 'running'
        ? { ...cur, status: 'failed', endedAt: at, error: `could not run opencode: ${String(err)}` }
        : cur,
    )
  } finally {
    streams.delete(id)
  }
}

/** The session folder and every git worktree of its repository: where a worker may run. */
async function allowedRoots($: $) {
  const listed = await $.process
    .run(['git', 'worktree', 'list', '--porcelain'], { cwd: sessionCwd })
    .catch(() => null)
  const worktrees =
    listed?.exitCode === 0
      ? listed.stdout.split('\n').filter(l => l.startsWith('worktree ')).map(l => l.slice('worktree '.length))
      : []
  const physical = await Promise.all([sessionCwd, ...worktrees].filter(Boolean).map(p => physicalPath($, p)))
  return physical.filter((p): p is string => p !== null)
}

/** A folder with its symlinks resolved, or null when it is not one. */
async function physicalPath($: $, path: string) {
  const out = await $.process.run(['/bin/pwd', '-P'], { cwd: path }).catch(() => null)
  return out?.exitCode === 0 && out.stdout.trim() ? out.stdout.trim() : null
}

/** The folder a worker runs in, resolved against the session's, or why it may not run there. */
async function resolveCwd($: $, cwd: string): Promise<{ cwd: string } | { error: string }> {
  if (!sessionCwd) return { error: 'the session folder is not known yet.' }
  const asked = normalizePath(cwd.startsWith('/') ? cwd : `${sessionCwd}/${cwd}`)
  // compared physically: a symlink inside the repo must not lead the worker out of it
  const target = await physicalPath($, asked)
  if (!target) return { error: `${asked} is not a folder.` }
  const roots = await allowedRoots($)
  return roots.some(root => isInside(target, root))
    ? { cwd: target }
    : { error: `${asked} is outside the session folder and its git worktrees.` }
}

type Spec = { prompt: string; title: string; cwd: string; model: string; agent: string }

async function startWorker($: $, spec: Spec) {
  const n = (await read($, seq)) + 1
  await update($, seq, () => n)
  const worker: Worker = {
    id: `w${n}`,
    sessionID: null,
    title: cut(oneLine(spec.title || spec.prompt), 60),
    model: spec.model || defaultModel,
    agent: spec.agent,
    cwd: spec.cwd || sessionCwd,
    prompt: spec.prompt,
    followUps: [],
    status: 'running',
    startedAt: await $.clock.now(),
    endedAt: null,
    steps: 0,
    cost: 0,
    tokensIn: 0,
    tokensOut: 0,
    files: [],
    changes: [],
    events: [],
    finalText: '',
    error: null,
  }
  live.set(worker.id, worker)
  await update($, workers, list => [...list, worker].slice(-50))
  await update($, selected, () => worker.id)
  void run($, worker.id, worker.prompt)
  void $.ui.open({ id: PANE, title: 'opencode' })
  return worker
}

/** Sends another instruction to a finished worker's opencode session. */
async function followUp($: $, id: string, message: string) {
  const text = message.trim()
  if (!text) return 'A follow-up needs some text.'
  const w = (await snapshot($)).find(x => x.id === id)
  if (!w) return `No opencode worker ${id}.`
  if (w.status === 'running') return `${id} is still running; wait for it or stop it first.`
  if (!w.sessionID) return `${id} has no opencode session to continue.`
  // a worker saved by an older version may sit outside today's roots
  const where = await resolveCwd($, w.cwd)
  if ('error' in where) return `${id} cannot continue: ${where.error}`

  const at = await $.clock.now()
  live.set(id, { ...w, cwd: where.cwd })
  await patch($, id, cur => ({
    ...cur,
    status: 'running',
    endedAt: null,
    error: null,
    followUps: [...cur.followUps, text],
    events: [...cur.events, { at, kind: 'prompt' as const, label: cut(oneLine(text), 160) }].slice(-EVENT_CAP),
  }))
  // The duration counts from the follow-up; earlier runs stay in steps and cost.
  await patch($, id, cur => ({ ...cur, startedAt: at }))
  await update($, selected, () => id)
  void run($, id, text)
  return `Sent a follow-up to ${id} (opencode session ${w.sessionID}).`
}

async function waitFor($: $, ids: string[] | null, seconds: number, signal?: AbortSignal) {
  const deadline = (await $.clock.now()) + Math.min(Math.max(seconds, 0), 600) * 1000
  for (;;) {
    const list = await snapshot($)
    const watched = ids ? list.filter(w => ids.includes(w.id)) : list
    if (!watched.some(w => w.status === 'running')) return
    if ((await $.clock.now()) >= deadline || signal?.aborted) return
    // A hook has 10 s of its own time and a $.clock wait counts against it;
    // the time a $ call is in flight does not, so the pause is a host sleep.
    await $.process.run(['/bin/sleep', '1'], { timeoutMs: 5_000 })
  }
}

async function stop($: $, id: string) {
  const stream = streams.get(id)
  if (!stream) return `${id} is not running.`
  const at = await $.clock.now()
  await patch($, id, w => ({ ...w, status: 'stopped', endedAt: at }))
  await stream.return(undefined as never)
  return `Stopped ${id}.`
}

export const register: Register = (on, options) => {
  defaultModel = str((options as Record<string, unknown>).defaultModel) || defaultModel
  extraDenied = patternsOf(str((options as Record<string, unknown>).extraDeniedCommands))

  on('session.start', async ($, e, next) => {
    const started = await next(e)
    sessionCwd = str((e as Record<string, unknown>).cwd)

    // A reload or a new process killed the children of the previous module;
    // workers saved by an older version lack the newer fields.
    const now = await $.clock.now()
    await update($, workers, list =>
      list.map(w => {
        const filled: Worker = { ...w, agent: w.agent ?? '', followUps: w.followUps ?? [], changes: w.changes ?? [] }
        return filled.status === 'running'
          ? { ...filled, status: 'interrupted' as const, endedAt: now, error: 'the mod reloaded or the session restarted; the opencode process was killed' }
          : filled
      }),
    )

    await $.command.register({ name: 'opencode', description: 'Show the opencode workers pane' })

    await $.tool.register({
      name: 'delegate',
      isDeferred: false,
      description: [
        'Start an opencode worker (a cheaper model run by the opencode CLI) on a self-contained task, in the background.',
        'Use it for simple exploration or for code changes that follow a plan already written down: the worker has none of this conversation, so the prompt must hold every file path, decision and acceptance check it needs.',
        'Returns at once with a worker id; the person watches progress and diffs in the opencode pane. Collect the result with the status tool (pass wait_seconds to block until it ends), then verify the work yourself (read the files, run the tests) — a worker report is a claim, not proof.',
        'Workers running in the same folder must not touch the same files. To correct or extend a finished worker, use follow_up rather than starting over.',
        'Deny rules stop a worker from committing, pushing or switching branches, deleting files, installing packages, reading or editing .env files, reaching outside its folder and running any command the user denied for their stack: leave those steps out of the brief and do them yourself. The rules match command patterns and are no sandbox, so review what a worker changed.',
      ].join(' '),
      inputSchema: {
        type: 'object',
        properties: {
          prompt: { type: 'string', description: 'The full, self-contained brief for the worker.' },
          title: { type: 'string', description: 'Short label shown in the pane (≤60 chars).' },
          cwd: {
            type: 'string',
            description: 'Folder to run in, inside the session folder or one of its git worktrees; defaults to the session folder.',
          },
          model: { type: 'string', description: `opencode model as provider/model; default ${defaultModel}.` },
          agent: { type: 'string', description: 'opencode agent name (e.g. "plan" for read-only); default the build agent.' },
        },
        required: ['prompt'],
      },
    })

    await $.tool.register({
      name: 'status',
      isDeferred: false,
      description:
        'Report on opencode workers. With id: that worker in full (files changed, recent activity, final answer). Without id: one line per worker. wait_seconds (≤600) blocks until the worker (or, without id, every running worker) ends or the time runs out.',
      inputSchema: {
        type: 'object',
        properties: {
          id: { type: 'string', description: 'Worker id, e.g. w3.' },
          wait_seconds: { type: 'number', description: 'Seconds to wait for it to finish, 0 for none.' },
        },
      },
    })

    await $.tool.register({
      name: 'follow_up',
      description:
        'Send another instruction to a finished opencode worker, in the same opencode session (it keeps its context). The worker runs again in the background; collect it with status.',
      inputSchema: {
        type: 'object',
        properties: {
          id: { type: 'string', description: 'Worker id, e.g. w3.' },
          prompt: { type: 'string', description: 'The instruction to send.' },
        },
        required: ['id', 'prompt'],
      },
    })

    await $.tool.register({
      name: 'stop',
      description: 'Stop a running opencode worker by id.',
      inputSchema: {
        type: 'object',
        properties: { id: { type: 'string' } },
        required: ['id'],
      },
    })

    return started
  })

  on('tool.call', { tool: 'mcp__opencode-workers__delegate' }, async ($, e) => {
    const input = e as Record<string, unknown>
    const prompt = str(input.prompt).trim()
    if (!prompt) return { deny: 'delegate needs a non-empty prompt.' }
    const model = str(input.model)
    const agent = str(input.agent)
    if (!isPlainName(model) || !isPlainName(agent)) return { deny: 'model and agent must be plain names, not flags.' }
    const where = await resolveCwd($, str(input.cwd))
    if ('error' in where) return { deny: `delegate: ${where.error}` }
    const w = await startWorker($, { prompt, title: str(input.title), cwd: where.cwd, model, agent })
    return {
      result: `Started opencode worker ${w.id} (${w.model}) in ${w.cwd || 'the session folder'}. Collect it with status { id: "${w.id}", wait_seconds: 300 }.`,
    }
  })

  on('tool.call', { tool: 'mcp__opencode-workers__status' }, async ($, e, next) => {
    const input = e as Record<string, unknown>
    const id = str(input.id)
    const wait = num(input.wait_seconds)
    const before = await snapshot($)
    if (id && !before.some(w => w.id === id)) return { deny: `No opencode worker ${id}.` }
    if (wait > 0) await waitFor($, id ? [id] : null, wait, next.signal)

    const now = await $.clock.now()
    const list = await snapshot($)
    if (id) return { result: report(list.find(w => w.id === id)!, now, true) }
    if (list.length === 0) return { result: 'No opencode workers yet.' }
    return { result: list.map(w => report(w, now, false)).join('\n') }
  })

  on('tool.call', { tool: 'mcp__opencode-workers__follow_up' }, async ($, e) => {
    const input = e as Record<string, unknown>
    return { result: await followUp($, str(input.id), str(input.prompt)) }
  })

  on('tool.call', { tool: 'mcp__opencode-workers__stop' }, async ($, e) => {
    const id = str((e as Record<string, unknown>).id)
    return { result: await stop($, id) }
  })

  on('command.run', { command: 'opencode' }, async $ => {
    const opened = await $.ui.open({ id: PANE, title: 'opencode', focus: true })
    return { text: opened.isPlaced ? 'opencode pane opened.' : `opencode pane waits: ${opened.reason}` }
  })

  // While the pane is closed, a band above the prompt says how the workers
  // stand and opens the pane again.
  on('ui.close', async ($, e, next) => {
    const closed = await next(e)
    if (e.id === PANE) $.ui.invalidate('ui.render')
    return closed
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.props.hasSurvey) return next(e)
    const list = await read($, workers)
    if (list.length === 0) return next(e)
    const isOpen = (await $.ui.panes()).some(p => p.id === PANE)
    if (isOpen) return next(e)

    const { Box, Text, Button } = $.ui.resolve(e)
    const running = list.filter(w => w.status === 'running').length
    const failed = list.filter(w => w.status === 'failed' || w.status === 'interrupted').length
    return (
      <Box flexDirection="row" gap={1} alignItems="center">
        <Text weight="semibold">opencode</Text>
        <Text color={running ? 'suggestion' : undefined} dimColor={!running}>
          {running ? `● ${running} running` : `${list.length} finished`}
        </Text>
        {failed > 0 && <Text color="error">✗ {failed} failed</Text>}
        <Button
          key="open-pane"
          label="Open panel"
          onPress={async () => {
            await $.ui.open({ id: PANE, title: 'opencode', focus: true })
            $.ui.invalidate('ui.render')
          }}
        />
      </Box>
    )
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const els = $.ui.resolve(e)
    const { Box, Text, Button, Markdown, Code } = els
    // mobile draws no Input: the follow-up field is left out there
    const Input = 'Input' in els ? els.Input : null
    const list = await read($, workers)
    const now = await $.clock.now()
    const width = Math.max(30, e.props.bodyColumns)
    const pick = (await read($, selected)) ?? list.at(-1)?.id ?? null
    const current = list.find(w => w.id === pick) ?? null
    const isDiffShown = await read($, showDiffs)
    const running = list.filter(w => w.status === 'running').length
    const totalCost = list.reduce((s, w) => s + w.cost, 0)

    if (list.length === 0) {
      return (
        <Box flexDirection="column" gap={1}>
          <Text size="heading" weight="semibold">No opencode workers yet</Text>
          <Text dimColor>Ask Claude to delegate a well-scoped task to opencode.</Text>
        </Box>
      )
    }

    const delta = (w: Worker) =>
      w.changes.reduce((s, c) => ({ add: s.add + c.additions, del: s.del + c.deletions }), { add: 0, del: 0 })

    const card = (w: Worker) => {
      const d = delta(w)
      const isPicked = w.id === pick
      return (
        <Box
          key={`card-${w.id}`}
          flexDirection="column"
          borderStyle="round"
          borderColor={isPicked ? 'claude' : 'subtle'}
          paddingX={1}
        >
          <Box flexDirection="row" gap={1} alignItems="center">
            {/* outside the Button: the desktop draws a Button's children in its own color */}
            <Text color={statusColor[w.status]} weight="semibold">{statusLabel[w.status]}</Text>
            <Button key={`row-${w.id}`} plain onPress={() => update($, selected, () => w.id)}>
              <Text weight={isPicked ? 'bold' : 'medium'}>{cut(w.title, Math.max(12, width - 30))}</Text>
            </Button>
          </Box>
          <Box flexDirection="row" gap={1}>
            <Text dimColor size="footnote">{w.id}</Text>
            <Text dimColor size="footnote">{shortModel(w.model)}</Text>
            <Text dimColor size="footnote" tabular>{duration(w, now)}</Text>
            <Text dimColor size="footnote" tabular>{w.steps} steps</Text>
            {w.changes.length > 0 && (
              <Text size="footnote" tabular>
                <Text dimColor>{w.changes.length} file{w.changes.length === 1 ? '' : 's'} </Text>
                <Text color="diffAdded" dimColor={d.add === 0}>+{d.add}</Text>{' '}
                <Text color="diffRemoved" dimColor={d.del === 0}>−{d.del}</Text>
              </Text>
            )}
            <Text dimColor size="footnote" tabular>${w.cost.toFixed(4)}</Text>
          </Box>
        </Box>
      )
    }

    const diffBlock = (c: FileChange) => {
      const lines = c.patch.split('\n')
      const shown = lines.length > DIFF_LINES_SHOWN ? `${lines.slice(0, DIFF_LINES_SHOWN).join('\n')}\n` : c.patch
      return (
        <Box key={`diff-${c.file}`} flexDirection="column" marginTop={1}>
          <Text>
            <Text weight="semibold">{changeMark[c.status]} {c.file}</Text>
            <Text color="diffAdded">  +{c.additions}</Text>
            <Text color="diffRemoved"> −{c.deletions}</Text>
          </Text>
          <Code source={shown} format="diff" path={c.file} />
          {lines.length > DIFF_LINES_SHOWN && (
            <Text dimColor size="footnote">… {lines.length - DIFF_LINES_SHOWN} more lines</Text>
          )}
        </Box>
      )
    }

    const detail = (w: Worker) => (
      <Box flexDirection="column" borderStyle="round" borderColor={statusColor[w.status]} paddingX={1} gap={1}>
        <Box flexDirection="column">
          <Text size="heading" weight="semibold">{w.id} · {w.title}</Text>
          <Text dimColor size="footnote" wrap="truncate-start">{w.cwd}</Text>
        </Box>

        <Box flexDirection="row" gap={1} flexWrap="wrap">
          {w.status === 'running' && <Button key="stop" label="Stop" onPress={() => void stop($, w.id)} />}
          {w.status !== 'running' && (
            <Button
              key="repeat"
              label="Repeat"
              onPress={async () => {
                // a worker saved by an older version may sit outside today's roots
                const where = await resolveCwd($, w.cwd)
                if ('error' in where) return $.ui.toast(`opencode: ${where.error}`)
                await startWorker($, { prompt: w.prompt, title: w.title, cwd: where.cwd, model: w.model, agent: w.agent })
              }}
            />
          )}
          {w.sessionID && (
            <Button
              key="copy-resume"
              label="Copy resume command"
              onPress={pe =>
                void $.ui.copy({ text: resumeCommand(w), surface: pe.surface })
              }
            />
          )}
          {w.changes.length > 0 && (
            <Button
              key="toggle-diffs"
              label={isDiffShown ? 'Hide diffs' : 'Show diffs'}
              onPress={() => update($, showDiffs, v => !v)}
            />
          )}
        </Box>

        <Box flexDirection="column">
          <Text weight="semibold">Brief</Text>
          <Text>{cut(oneLine(w.prompt), 400)}</Text>
          {w.followUps.map((f, i) => (
            <Text key={`fu-${i}`} color="suggestion">» {cut(oneLine(f), 300)}</Text>
          ))}
        </Box>

        {w.changes.length > 0 && (
          <Box flexDirection="column">
            <Text weight="semibold">
              Changes · {w.changes.length} file{w.changes.length === 1 ? '' : 's'}
            </Text>
            {isDiffShown
              ? w.changes.map(diffBlock)
              : w.changes.map(c => (
                  <Text key={`file-${c.file}`}>
                    {changeMark[c.status]} {c.file} <Text color="diffAdded">+{c.additions}</Text>{' '}
                    <Text color="diffRemoved">−{c.deletions}</Text>
                  </Text>
                ))}
          </Box>
        )}

        <Box flexDirection="column">
          <Text weight="semibold">Activity</Text>
          {w.events.length === 0 && <Text dimColor>waiting for the first step…</Text>}
          {w.events.slice(-12).map((ev, i) => (
            <Text
              key={`ev-${i}`}
              color={ev.kind === 'error' ? 'error' : ev.kind === 'prompt' ? 'suggestion' : undefined}
              dimColor={ev.kind === 'tool'}
              wrap="truncate-end"
            >
              {ev.kind === 'text' ? '› ' : ev.kind === 'prompt' ? '» ' : '  '}
              {ev.label}
            </Text>
          ))}
        </Box>

        {w.error && <Text color="error">{cut(w.error, 600)}</Text>}

        {w.status !== 'running' && w.finalText && (
          <Box flexDirection="column">
            <Text weight="semibold">Answer</Text>
            <Markdown key={`answer-${w.id}`} text={w.finalText} />
          </Box>
        )}

        {Input && w.status !== 'running' && w.sessionID && (
          <Input
            key={`follow-up-${w.id}`}
            label="Follow-up"
            placeholder="Send another instruction to this opencode session"
            submitLabel="Send"
            onSubmit={(value: string) => void followUp($, w.id, value)}
          />
        )}
      </Box>
    )

    return (
      <Box flexDirection="column" gap={1}>
        <Box flexDirection="row" justifyContent="space-between" alignItems="center">
          <Text size="footnote" dimColor tabular>
            {running} running · {list.length - running} finished · ${totalCost.toFixed(4)}
          </Text>
          {list.length > running && (
            <Button
              key="clear"
              label="Clear finished"
              onPress={async () => {
                for (const w of list) if (w.status !== 'running') live.delete(w.id)
                await update($, workers, l => l.filter(w => w.status === 'running'))
                await update($, selected, () => null)
              }}
            />
          )}
        </Box>

        <Box flexDirection="column" gap={1}>{[...list].reverse().map(card)}</Box>

        {current && detail(current)}
      </Box>
    )
  })
}
