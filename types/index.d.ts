export type Task = {
  id: string
  label: string
  percent: number | null
  current: number | null
  total: number | null
  phase: string | null
  state: 'running' | 'done' | 'failed'
  updatedAt: number
  etaMs: number | null
}

export type BackgroundTask = {
  id: string
  label: string
  startedAt: number
  endedAt: number | null
  status: string | null
}

export type Activity = {
  isTurnRunning: boolean
  lastAt: number
  runningTool: string | null
  toolStartedAt: number | null
}

declare module 'claude-code' {
  interface PluginState {
    'task-progress': { tasks: Task[]; background: BackgroundTask[]; activity: Activity; tick: number }
  }
}
