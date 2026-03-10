# Agent-Mon

Real-time visual monitoring dashboard for [Claude Code](https://docs.anthropic.com/en/docs/claude-code) agents. See all your running sessions, subagents, tools, and skills as an interactive force-directed graph.

![img.png](img.png)

## Features

- **Live force-directed graph** — projects, sessions, subagents, and tools rendered as interactive nodes
- **Active session detection** — running sessions pulse green, detected via process inspection + file modification times
- **Real-time updates** — file watcher + SSE push changes to the browser as they happen
- **Session detail panel** — click any session to see model, tools used, skills, subagents, git branch, timestamps, and more
- **Tool hub visualization** — shared tool nodes show which tools are most used across sessions
- **Filter controls** — toggle tool nodes on/off, filter to active sessions only

## How it works

Agent-Mon reads directly from Claude Code's local data files in `~/.claude/projects/`:

| Data Source | What it provides |
|---|---|
| `<project>/<sessionId>.jsonl` | Messages, tool calls, model, timestamps |
| `<project>/<sessionId>/subagents/agent-*.meta.json` | Subagent types (Explore, Plan, etc.) |
| `<project>/<sessionId>/subagents/agent-*.jsonl` | Subagent tool usage |
| `<project>/sessions-index.json` | Session summaries, message counts |
| `~/.claude/stats-cache.json` | Aggregate usage stats |

Active sessions are detected by cross-referencing running `claude` processes (via `ps` + `lsof`) with recently modified session files.

## Quick start

```bash
git clone https://github.com/youruser/agent-mon.git
cd agent-mon
npm install
npm start
```

Open [http://localhost:3000](http://localhost:3000)

## Requirements

- **Node.js** >= 18
- **Claude Code** installed and used (needs `~/.claude/projects/` to exist)
- **macOS** or **Linux** (uses `ps` and `lsof` for process detection)

## Project structure

```
agent-mon/
  server.js              # Express server, API endpoints, SSE
  lib/
    scanner.js           # Discovers projects/sessions/subagents from ~/.claude
    parser.js            # Parses JSONL session logs
    process-detector.js  # Detects running claude processes
    watcher.js           # File system watcher (chokidar)
    graph-builder.js     # Builds D3-compatible graph data
  public/
    index.html           # Dashboard page
    app.js               # D3 force graph + SSE consumer
    style.css            # Dark theme styling
```

## API

| Endpoint | Description |
|---|---|
| `GET /` | Dashboard UI |
| `GET /api/graph` | Full graph JSON (nodes + edges) |
| `GET /api/session/:id` | Session detail HTML fragment |
| `GET /api/summary` | Counts (projects, sessions, active) |
| `GET /api/stats` | Usage statistics |
| `GET /events` | SSE stream for real-time updates |

### Query parameters for `/api/graph`

- `tools=false` — hide tool nodes
- `maxSessions=N` — limit sessions per project (default: 15)

## Graph node types

| Node | Color | Description |
|---|---|---|
| Project | Blue | A directory where Claude Code has been used |
| Session (active) | Green (pulsing) | Currently running Claude Code session |
| Session (inactive) | Gray | Past session |
| Subagent | Orange | Agent spawned by a session (Explore, Plan, etc.) |
| Tool | Purple | Built-in tool (Bash, Read, Edit, Grep, etc.) |

## Configuration

Set the port via environment variable:

```bash
PORT=8080 npm start
```

## Development

```bash
npm run dev  # auto-restart on file changes (Node.js --watch)
```

## Tech stack

- **Backend**: Node.js, Express, chokidar
- **Frontend**: D3.js v7 (force graph), HTMX (detail panel), vanilla CSS
- **No bundler, no database** — reads Claude Code's files directly

## Privacy

Agent-Mon runs entirely locally. It only reads files from your local `~/.claude/` directory and serves a dashboard on `localhost`. No data is sent anywhere.

## License

MIT
