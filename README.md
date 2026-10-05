# task-progress

A Claude Code mod that draws a progress bar above the prompt for every long task that reports one, from any thread, script or agent.

Report with `bin/progress` (link it onto your PATH):

```bash
progress kernel 812 4500 "Pixel 4a kernel" "compiling"
progress kernel pct 40
progress kernel done
progress kernel clear
```

It writes `~/.local/state/agent-progress/<id>.json` (`label`, `current`, `total`, `percent`, `phase`, `state`, `updatedAt`, all optional), so anything that can write a file can report. The mod polls that folder every 2 s, hides a running task silent for 15 minutes and a finished one after a minute, and passes the band on to other plugins' bands.
