import { atom, read, update } from 'claude-code'
import type { Register } from 'claude-code'

import type { Task } from '../types'

// Any process reports a task by writing <DIR>/<id>.json:
// { "label": "kernel build", "current": 812, "total": 4500, "percent": 18, "phase": "3/6 compiling",
//   "state": "running" | "done" | "failed", "updatedAt": <epoch ms> }   every field optional.
const DIR = '.local/state/agent-progress'
const POLL_MS = 2000
// A running task that has not written for this long is assumed dead and hidden.
const STALE_MS = 15 * 60e3
// A finished task stays on screen this long.
const DONE_SHOWN_MS = 60e3
const BAR_CELLS = 20

const tasks = atom({ plugin: 'task-progress', key: 'tasks' } as const, [])

const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : null)
const str = (v: unknown) => (typeof v === 'string' && v.trim() ? v.trim() : null)

const duration = (ms: number) => {
  const s = Math.max(0, Math.round(ms / 1000))
  return s >= 3600 ? `${Math.floor(s / 3600)}h${String(Math.floor((s % 3600) / 60)).padStart(2, '0')}m`
    : s >= 60 ? `${Math.floor(s / 60)}m${String(s % 60).padStart(2, '0')}s` : `${s}s`
}

// First sighting of each task, for the ETA: percent and time.
const firstSeen = new Map<string, { at: number; percent: number }>()

async function poll($: any) {
  const home = await $.env.get('HOME')
  if (!home) return
  const dir = `${home}/${DIR}`
  const entries = await $.fs.list(dir).catch(() => [])
  const now = await $.clock.now()
  const found: Task[] = []
  for (const entry of entries) {
    if (entry.kind !== 'file' || !entry.name.endsWith('.json')) continue
    const id = entry.name.slice(0, -5)
    const raw = await $.fs.read(`${dir}/${entry.name}`).catch(() => null)
    if (raw === null) continue
    let data: Record<string, unknown>
    try { data = JSON.parse(raw as string) } catch { continue }
    const current = num(data.current)
    const total = num(data.total)
    const percent = num(data.percent) ?? (current !== null && total ? (current / total) * 100 : null)
    const state = data.state === 'done' || data.state === 'failed' ? data.state : 'running'
    const updatedAt = num(data.updatedAt) ?? entry.mtimeMs
    const age = now - updatedAt
    if (state === 'running' ? age > STALE_MS : age > DONE_SHOWN_MS) continue
    let etaMs: number | null = null
    if (percent !== null && state === 'running') {
      const first = firstSeen.get(id)
      if (!first || percent < first.percent) firstSeen.set(id, { at: now, percent })
      else if (percent > first.percent) etaMs = ((now - first.at) / (percent - first.percent)) * (100 - percent)
    }
    found.push({ id, label: str(data.label) ?? id, percent, current, total, phase: str(data.phase), state, updatedAt, etaMs })
  }
  found.sort((a, b) => a.id.localeCompare(b.id))
  const before = await read($, tasks)
  if (JSON.stringify(before) !== JSON.stringify(found)) await update($, tasks, () => found)
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    const started = await next(e)
    await poll($)
    $.clock.every(POLL_MS, () => { void poll($) })
    return started
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const shown = await read($, tasks)
    const below = await next(e)
    if (e.props.hasSurvey || shown.length === 0) return below
    const { Box, Text } = $.ui.resolve(e)
    const now = await $.clock.now()

    return (
      <Box flexDirection="column">
        {shown.map(t => {
          const share = t.percent === null ? 0 : Math.min(1, Math.max(0, t.percent / 100))
          const filled = Math.round(share * BAR_CELLS)
          const color = t.state === 'failed' ? 'red' : t.state === 'done' ? 'green' : undefined
          const count = t.current !== null ? (t.total !== null ? `${t.current}/${t.total}` : `${t.current}`) : null
          const quiet = now - t.updatedAt > 60e3 ? `quiet ${duration(now - t.updatedAt)}` : null
          return (
            <Box key={t.id} flexDirection="row" columnGap={1}>
              <Text>{t.label}</Text>
              <Text color={color}>{'█'.repeat(filled)}<Text dimColor>{'░'.repeat(BAR_CELLS - filled)}</Text></Text>
              <Text color={color}>{t.state === 'done' ? 'done' : t.state === 'failed' ? 'failed' : t.percent === null ? '…' : `${Math.round(t.percent)}%`}</Text>
              {t.phase ? <Text dimColor>{t.phase}</Text> : null}
              {count ? <Text dimColor>{count}</Text> : null}
              {t.etaMs !== null ? <Text dimColor>~{duration(t.etaMs)} left</Text> : null}
              {quiet ? <Text color="yellow">{quiet}</Text> : null}
            </Box>
          )
        })}
        {below}
      </Box>
    )
  })
}
