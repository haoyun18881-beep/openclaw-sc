# OpenClaw sc

sc is an OpenClaw agent control plane. It gives an OpenClaw main agent a bounded
way to dispatch sub-agents, route tools, run local worker jobs, collect
completion events, search memory, fetch web evidence, edit files, and validate
code without turning the human chat into a coordination log.

The short version: sc is not just a bag of tools. It is the execution layer that
lets an agent act like a task commander while still leaving behind artifacts
that a human or a main agent can inspect.

This repository is the public source package. It excludes private runtime
state, local logs, task inbox files, backups, service binaries, credentials, and
machine-specific OpenClaw memory.

## Why This Exists

Most agent runtimes can call tools, but larger work quickly needs more than
one-off tool calls:

- A main agent needs to send bounded work to sub-agents.
- Sub-agents need fewer permissions than the main agent.
- Results need to come back as inspectable completion events, not noisy chat.
- Repetitive local work should run in cheap deterministic workers.
- Code edits need a validation path.
- Memory and web evidence need short, bounded returns.
- Large fan-out needs run IDs, collector discipline, and timeout behavior.

sc is built around those operational problems.

## What Makes sc Different

| Strength | What it means |
| --- | --- |
| Agent control plane | `spawnAgent` and `taskPipeline` create bounded AI sub-tasks instead of asking the main agent to do every step. |
| Completion inbox | Sub-agent completion events can be stored, reported, acknowledged, and kept out of the human chat when desired. |
| Tool boundary model | Main and sub-agent tool sets are different. Sub-agents cannot recursively spawn agents or trigger high-risk controls. |
| Deterministic worker lane | `spawnWorker` handles search, analyze, semantic, diff, and stats work without spending model tokens. |
| Evidence-friendly tools | `grep`, `glob`, `memorySearch`, and `webSearch` return bounded evidence for review instead of uncontrolled dumps. |
| Validation guardrails | Sub-agent code edits can be followed by `validate` checks such as syntax, module load, and diff review. |
| Batch orchestration | `taskPipeline` supports multi-group dispatch, staggered fan-out, fire-and-return behavior, and collector fields. |
| Memory retrieval hooks | Dialog search, semantic search, full memory query, and compressed recall can be exposed through one memory tool. |
| Local-first package | The public package ships source and contracts, not private logs, inbox state, credentials, service binaries, or backups. |

## Core Capabilities

### 1. Sub-agent dispatch

`spawnAgent` sends a single bounded AI task with a self-contained prompt and
optional task-card fields such as:

- `runId`
- `runDir`
- `taskName`
- `batchName`
- `groupName`
- `collector`
- `budgets`
- `acceptance`
- `evidence`
- `toolPolicy`

The point is not only to start another model. The point is to make the task
auditable: what was requested, which tools were allowed, what evidence was
expected, and how the result should be collected.

### 2. Multi-agent pipelines

`taskPipeline` dispatches multiple named groups. It is designed for fan-out work
such as:

- multi-perspective audits
- competing implementation ideas
- independent research slices
- batch code review
- large workspace inventory
- task trees where each group has a different prompt

It can wait for completion, stop waiting after `maxWait`, or fire-and-return
when the caller wants to collect results later through the inbox and task-state
artifacts.

### 3. Completion inbox

The `scInbox` tool and sidecar endpoints turn sub-agent results into completion
events:

- `pending` returns unacknowledged completions.
- `recent` returns recent completions, including acknowledged ones.
- `report` builds a concise completion report.
- `ack` marks events handled.
- `stats` gives inbox health.

This solves a practical coordination issue: the main agent can know that a
sub-agent finished, while the human chat can stay clean. A deployment can run in
`notify-only` mode so completion state is delivered to the host without
injecting every sub-agent result into the user-facing conversation.

### 4. Tool bridge

sc exposes a compact MCP-style tool surface:

| Tool | Purpose |
| --- | --- |
| `stats` | Worker pool and queue snapshot. |
| `memorySearch` | Smart memory lookup, dialog search, semantic search, full query, or compressed recall. |
| `webSearch` | Web search and web fetch through configured backends. |
| `glob` | Workspace file discovery. |
| `grep` | Fast ripgrep-backed search with bounded output modes. |
| `codeEditor` | Review or precise text replacement edits. |
| `batchVision` | Serial image analysis for GPU-friendly visual inspection. |
| `fileManager` | Read, write, list, copy, and move within allowed boundaries. |
| `spawnWorker` | Local deterministic worker tasks. |
| `spawnAgent` | Single AI sub-agent task. |
| `taskPipeline` | Multi-group AI task orchestration. |
| `scInbox` | Completion event collection and acknowledgement. |
| `validate` | Syntax, module-load, and diff validation for sub-agent edits. |
| `emergencyStop` | Explicit high-risk stop path. Not for routine status checks. |

### 5. Local worker path

Not every task needs another model call. The worker lane is for deterministic,
cheap, local work:

- keyword search
- file analysis
- semantic helper jobs
- diff checks
- pool stats

The plugin entry maintains worker-pool behavior such as queue handling, worker
replacement, and backpressure-oriented status reporting. This gives the agent a
faster path for mechanical work and keeps model budget for judgment-heavy work.

### 6. Safety model

sc intentionally gives sub-agents a narrower tool surface than the main agent.
For example:

- sub-agents cannot call `spawnAgent`
- sub-agents cannot call `taskPipeline`
- sub-agents cannot call `scInbox`
- sub-agents cannot call `batchVision`
- sub-agents cannot use `emergencyStop`
- file operations do not expose delete
- write operations are restricted by workspace policy
- validation is available to sub-agents after code edits

This does not make arbitrary tasks safe by itself. It gives the host a clearer
place to enforce task cards, budgets, tool policy, and review gates.

## Typical Use Cases

- Let one main OpenClaw agent dispatch 3 to 10 bounded review tasks and collect
  structured completion events.
- Run a background search or workspace inventory without flooding the chat.
- Give sub-agents enough tools to inspect and edit code while blocking recursive
  spawning and emergency controls.
- Combine AI sub-agents with zero-token local workers for faster triage.
- Keep memory and web retrieval short enough for a main agent to verify.
- Build a task pipeline where each slice has its own model, timeout, and
  success criteria.
- Keep human-facing chat focused on decisions while machine-facing inboxes
  carry raw completion state.

## Architecture

```text
OpenClaw main agent
  -> tools/bridge.js
      -> grep / glob / memorySearch / webSearch / fileManager / codeEditor
      -> spawnWorker -> workers/worker.js
      -> spawnAgent  -> tools/sidecar/subagent-runner.cjs
      -> taskPipeline -> multiple sub-agent runner tasks
  -> tools/sidecar/sidecar-server.cjs
      -> completion inbox
      -> task state artifacts
      -> pending / recent / report / ack / stats
```

The bridge is the tool boundary. The sidecar is the completion and task-state
boundary. The worker pool is the deterministic local execution boundary.

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
| `SC_INBOX_NOTIFY_ACK` | Whether background notification should acknowledge delivered inbox events. |
| `SC_INBOX_CHAT_INJECT` | Whether inbox completion messages are injected into chat. |
| `SC_INBOX_AUTO_NOTIFY` | Whether the bridge should notify the host automatically when completions arrive. |

## Main Files

| Path | Purpose |
| --- | --- |
| `index.js` | OpenClaw plugin entry and worker-pool integration. |
| `openclaw.plugin.json` | Plugin metadata and tool contracts. |
| `tools/mcp-tools.config.json` | Public tool schema and main/sub-agent tool boundaries. |
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
