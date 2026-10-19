export type WorkerStatus = 'running' | 'done' | 'failed' | 'stopped' | 'interrupted'

export type WorkerEvent = {
  at: number
  kind: 'tool' | 'text' | 'error' | 'prompt'
  label: string
}

/** What a worker did to one file: its hunks as one unified diff body. */
export type FileChange = {
  file: string
  status: 'added' | 'modified' | 'rewritten'
  additions: number
  deletions: number
  patch: string
}

export type Worker = {
  id: string
  sessionID: string | null
  title: string
  model: string
  agent: string
  cwd: string
  prompt: string
  followUps: string[]
  status: WorkerStatus
  startedAt: number
  endedAt: number | null
  steps: number
  cost: number
  tokensIn: number
  tokensOut: number
  files: string[]
  changes: FileChange[]
  events: WorkerEvent[]
  finalText: string
  error: string | null
}

declare module 'claude-code' {
  interface PluginState {
    'opencode-workers': {
      workers: Worker[]
      selected: string | null
      seq: number
      showDiffs: boolean
    }
  }
}
