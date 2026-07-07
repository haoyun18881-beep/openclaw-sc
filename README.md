# OpenClaw sc

sc is an OpenClaw plugin for local agent orchestration. It adds sub-agent task
dispatch, MCP-style tool routing, local worker jobs, memory search helpers, and
sidecar delivery plumbing for OpenClaw runtimes.

This repository is the public source package. It excludes private runtime
state, local logs, task inbox files, backups, service binaries, and credentials.

## What sc Provides

| Area | Capability |
| --- | --- |
| Sub-agent orchestration | Dispatches bounded sub-agent tasks and records completion artifacts. |
| MCP tool bridge | Exposes search, memory, file, code, worker, and pipeline tools through a bridge layer. |
| Local worker path | Runs deterministic local worker jobs without spending model tokens. |
| Memory helpers | Provides SQLite, FTS, and optional vector-search helper modules. |
| Sidecar integration | Receives sub-agent completion events through a sidecar server and inbox flow. |
| Safety controls | Includes prompt-injection checks, blocked-tool rules, and emergency stop boundaries. |

## Requirements

- OpenClaw with plugin support.
- Node.js 22 or newer.
- PowerShell on Windows for the documented install commands.
- Optional: `rg` / ripgrep installed on PATH, or set `SC_RG_PATH`.
- Optional: Tavily, DeepSeek, Ollama, or other provider keys depending on which
  tools you enable.

The npm package does not include private runtime directories or Windows service
helpers. If your local deployment uses NSSM or bundled binaries, keep those in
your private runtime install, not in the public package.

## Install From Source

```powershell
git clone https://github.com/haoyun18881-beep/openclaw-sc.git
cd openclaw-sc
npm install
npm run lint
```

Copy the plugin into your OpenClaw plugin workspace:

```powershell
$target = "$env:USERPROFILE\.openclaw\workspace\plugins\sc"
New-Item -ItemType Directory -Force -Path $target | Out-Null
Copy-Item -Recurse -Force .\* $target
```

Then add or enable `sc` in your OpenClaw plugin configuration. The exact
OpenClaw config shape can vary by runtime version, but the plugin entry should
point at the copied `sc` directory and load `openclaw.plugin.json`.

## Runtime Configuration

Start from the empty example:

```powershell
Copy-Item .env.example .env
```

Keep real secrets out of git. Common settings:

| Variable | Purpose |
| --- | --- |
| `DEEPSEEK_API_KEY` | Optional model provider key used by configured tools. |
| `TAVILY_API_KEY` | Optional web-search key. |
| `OLLAMA_BASE_URL` | Optional local vision/model endpoint. |
| `SC_RG_PATH` | Optional explicit path to `rg`; otherwise sc tries bundled rg, then system `rg`. |
| `SC_SIDECAR_PORT` | Sidecar port when the sidecar server is used. |
| `SC_INBOX_DELIVERY_MODE` | Inbox completion delivery mode, for example `notify-only`. |
| `SC_INBOX_CHAT_INJECT` | Whether inbox completion messages are injected into chat. |

## Main Files

| Path | Purpose |
| --- | --- |
| `index.js` | OpenClaw plugin entry. |
| `openclaw.plugin.json` | Plugin metadata and tool contracts. |
| `lib/` | Core routing, task, memory, security, and orchestration modules. |
| `tools/bridge.js` | Tool bridge and MCP-style tool handlers. |
| `tools/sidecar/sidecar-server.cjs` | Sidecar server for completion delivery. |
| `tools/sidecar/subagent-runner.cjs` | Sub-agent runner process. |
| `workers/worker.js` | Local worker implementation. |
| `vector/` | Optional vector-search helper modules. |

## Validation

Run syntax checks:

```powershell
npm run lint
```

Preview the npm package contents:

```powershell
npm run pack:dry
```

The package preview should not include:

- `node_modules/`
- `logs/`
- `tools/sidecar/inbox/`
- `tools/sidecar/tasks/`
- `.env`
- private OpenClaw memory or session files
- `nssm.exe`
- backup files such as `*.bak`

## Security

sc can touch local files, memory records, tool outputs, and sub-agent task
artifacts. Review `SECURITY.md` before publishing forks or sharing task reports.
Never publish real `.env`, `openclaw.json`, logs, task-state JSON, inbox events,
credentials, cookies, tokens, private prompts, or full local paths from a
private deployment.

## License

Business Source License 1.1. See `LICENSE`.
