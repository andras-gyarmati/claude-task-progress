import { atom, read, update } from 'claude-code'
import type { Register } from 'claude-code'

import type { Activity, BackgroundTask, Task } from '../types'

// Any process reports a task by writing <DIR>/<id>.json:
// { "label": "kernel build", "current": 812, "total": 4500, "percent": 18, "phase": "3/6 compiling",
//   "state": "running" | "done" | "failed", "updatedAt": <epoch ms> }   every field optional.
const DIR = '.local/state/agent-progress'
const CLIP_DIR = '.local/state/clipboard-shots'
const POLL_MS = 2000
const TICK_MS = 5000
// A running task that has not written for this long is assumed dead and hidden.
const STALE_MS = 15 * 60e3
// A finished task stays on screen this long.
const DONE_SHOWN_MS = 60e3
// A turn with no tool call starting or ending for this long reads as possibly stuck. A guess.
const STALL_MS = 3 * 60e3
const BAR_CELLS = 20
// Wider than any terminal; the divider row clips it to the band's width.
const DIVIDER = '─'.repeat(400)

const tasks = atom({ plugin: 'task-progress', key: 'tasks' } as const, [])
const background = atom({ plugin: 'task-progress', key: 'background' } as const, [])
const activity = atom({ plugin: 'task-progress', key: 'activity' } as const, { isTurnRunning: false, lastAt: 0, runningTool: null, toolStartedAt: null })
const tick = atom({ plugin: 'task-progress', key: 'tick' } as const, 0)

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
  // Profiles share HOME, so every profile sees every file; show only this account's tasks and unstamped ones.
  const account = await $.env.get('CLAUDE_CODE_ACCOUNT_UUID')
  const found: Task[] = []
  for (const entry of entries) {
    if (entry.kind !== 'file' || !entry.name.endsWith('.json')) continue
    const id = entry.name.slice(0, -5)
    const raw = await $.fs.read(`${dir}/${entry.name}`).catch(() => null)
    if (raw === null) continue
    let data: Record<string, unknown>
    try { data = JSON.parse(raw as string) } catch { continue }
    if (account && str(data.account) && data.account !== account) continue
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
  const done = (await read($, background)).filter(t => t.endedAt === null || now - t.endedAt < DONE_SHOWN_MS)
  if (done.length !== (await read($, background)).length) await update($, background, () => done)
}

// Redraws elapsed times while something time-based is on screen.
async function advance($: any) {
  const busy = (await read($, background)).some(t => t.endedAt === null) || (await read($, activity)).isTurnRunning
  if (busy) await update($, tick, n => n + 1)
}

async function touch($: any, tool: string | null) {
  const now = await $.clock.now()
  await update($, activity, a => ({ ...a, lastAt: now, runningTool: tool, toolStartedAt: tool ? now : null }))
}

async function saveClipboard($: any) {
  const home = await $.env.get('HOME')
  const now = await $.clock.now()
  const path = `${home}/${CLIP_DIR}/clip-${now}.png`
  await $.fs.write(`${home}/${CLIP_DIR}/.keep`, '')
  const script = [
    `set f to open for access POSIX file "${path}" with write permission`,
    'write (the clipboard as «class PNGf») to f',
    'close access f',
  ]
  const run = $.process.spawn({ argv: ['/usr/bin/osascript', ...script.flatMap(line => ['-e', line])] })
  for await (const _ of run) { /* drain */ }
  const { code } = await run.result
  return code === 0 ? path : null
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    const started = await next(e)
    await $.command.register({ name: 'clip', description: 'Attach the image on the clipboard (a screenshot) to the conversation' })
    await poll($)
    $.clock.every(POLL_MS, () => { void poll($) })
    $.clock.every(TICK_MS, () => { void advance($) })
    return started
  })

  on('command.run', { command: 'clip' }, async $ => {
    const path = await saveClipboard($)
    return path
      ? { text: `Screenshot from the clipboard saved to ${path}. Read it with the Read tool before answering.` }
      : { text: 'The clipboard holds no image.' }
  })

  on('prompt.submit', async ($, e, next) => {
    const now = await $.clock.now()
    await update($, activity, () => ({ isTurnRunning: true, lastAt: now, runningTool: null, toolStartedAt: null }))
    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    await update($, activity, a => ({ ...a, isTurnRunning: false, runningTool: null, toolStartedAt: null }))
    return next(e)
  })

  on('tool.call', async ($, e, next) => {
    await touch($, e.tool)
    const ran = await next(e)
    await touch($, null)
    const id = e.tool === 'Bash' ? (ran.result as any)?.backgroundTaskId : undefined
    if (typeof id === 'string') {
      const now = await $.clock.now()
      const label = str((e as any).description) ?? String((e as any).command ?? 'background command').slice(0, 60)
      await update($, background, list => [...list.filter(t => t.id !== id), { id, label, startedAt: now, endedAt: null, status: null }])
    }
    return ran
  })

  on('ui.render', { component: 'UserMessage', props: { origin: { kind: 'task-notification' } } }, async ($, e, next) => {
    const task = e.props.task
    if (task?.id) {
      const list = await read($, background)
      if (list.some(t => t.id === task.id && t.endedAt === null)) {
        const now = await $.clock.now()
        await update($, background, all => all.map(t => (t.id === task.id ? { ...t, endedAt: now, status: task.status ?? 'ended' } : t)))
      }
    }
    return next(e)
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const shown = await read($, tasks)
    const bg = await read($, background)
    const act = await read($, activity)
    await read($, tick)
    const below = await next(e)
    const now = await $.clock.now()
    const stalled = act.isTurnRunning && act.runningTool === null && act.lastAt > 0 && now - act.lastAt > STALL_MS
    const longTool = act.isTurnRunning && act.runningTool !== null && act.toolStartedAt !== null && now - act.toolStartedAt > STALL_MS
    if (e.props.hasSurvey || (shown.length === 0 && bg.length === 0 && !stalled && !longTool)) return below
    const { Box, Text } = $.ui.resolve(e)

    return (
      <Box flexDirection="column">
        {shown.map(t => {
          const share = t.percent === null ? 0 : Math.min(1, Math.max(0, t.percent / 100))
          const filled = Math.round(share * BAR_CELLS)
          const color = t.state === 'failed' ? 'red' : t.state === 'done' ? 'green' : undefined
          const count = t.current !== null ? (t.total !== null ? `${t.current}/${t.total}` : `${t.current}`) : null
          const quiet = now - t.updatedAt > 60e3 && t.state === 'running' ? `quiet ${duration(now - t.updatedAt)}` : null
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
        {bg.map(t => {
          const failed = t.status !== null && t.status !== 'completed'
          const color = t.endedAt === null ? undefined : failed ? 'red' : 'green'
          return (
            <Box key={`bg-${t.id}`} flexDirection="row" columnGap={1}>
              <Text dimColor>bg</Text>
              <Text>{t.label}</Text>
              <Text color={color}>{t.endedAt === null ? `running ${duration(now - t.startedAt)}` : `${t.status} after ${duration(t.endedAt - t.startedAt)}`}</Text>
            </Box>
          )
        })}
        {stalled ? <Text color="yellow">no tool activity for {duration(now - act.lastAt)}, the agent may be stuck</Text> : null}
        {longTool ? <Text color="yellow">{act.runningTool} running for {duration(now - act.toolStartedAt!)}</Text> : null}
        {below ? <Box height={1} overflow="hidden"><Text dimColor>{DIVIDER}</Text></Box> : null}
        {below}
      </Box>
    )
  })
}
