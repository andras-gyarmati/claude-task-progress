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

declare module 'claude-code' {
  interface PluginState {
    'task-progress': { tasks: Task[] }
  }
}
