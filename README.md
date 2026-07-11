# OpenClaw sc

> **让 OpenClaw 默认百路、配置即可100+子 Agent 大面积调研、查代码和找 Bug，再把本地免费任务交给真正的多核 CPU Worker。**

OpenClaw sc 是 OpenClaw 深度适配版的 Agent 控制平面。它不是“小工具合集”，而是把一个主 Agent 升级成任务总指挥：AI 任务走百级并行，本地确定性任务走多核 Worker，结果统一回收到收件箱和证据链。

## 它最强的地方

### 1. 默认百路、可配置100+子 Agent 并行全网调研

一个问题可以拆成上百条独立路线，同时搜索网站、文档、社区和不同来源。公共代码默认支持100组 `taskPipeline`，上限可配置继续提高。

### 2. 默认百路、可配置100+子 Agent 同时查大型代码项目

可以把仓库按目录、模块、语言或风险面切开，让百级子 Agent 同时找 Bug、查安全问题、做代码审计和交叉验证，而不是让一个 Agent 串行翻完整个仓库。

### 3. 真正的多核本地 Worker

搜索、切片、统计、diff、批处理等确定性任务不需要调用 LLM，不花模型 Token。Worker 池按检测到的 CPU 核心数自动扩展，也可以通过配置控制，多核机器可以真正发挥出来。

### 4. 主 Agent 只负责判断，不再亲自搬砖

最强的模型留给规划、任务拆分、复核和最终裁决；重复搜索和大面积扫描交给子 Agent 或本地 Worker。

### 5. 百路结果不会淹没主聊天

完成事件进入 Completion Inbox（完成收件箱），可以查看、确认和回收，不需要把几百条协调信息全部塞进用户聊天。

### 6. 主 Agent 和子 Agent 权限分开

子 Agent 不能递归派兵，也不能直接调用高风险控制。大规模并行仍然有任务边界、超时、失败阈值和停止条件。

### 7. 搜索、代码修改和验证形成闭环

SC 不只会派任务，还能回收证据、检查缺失路线，并对代码修改执行语法、模块加载和 diff 验证。

### 8. 为 OpenClaw 深度适配，也能作为通用 Agent 架构参考

SC 直接接入 OpenClaw 的插件、工具、会话和记忆体系；它的 TaskCard、流水线、Worker、收件箱和证据回收设计也可以移植到其他智能体框架。

## 最简单的用法

安装并启用后，直接告诉 OpenClaw：

```text
同时派100个子 Agent，全网调研这个问题
把这个代码仓库切成100路，同时查 Bug
用 taskPipeline 做百路并行审计
用本地 Worker 切片、搜索、统计和 diff
把子 Agent 结果收进完成收件箱，最后统一复核
```

`spawnAgent` 用于单路任务；多路并行使用 `taskPipeline`。默认流水线上限是100组，可以通过 `SC_PIPELINE_MAX_GROUPS` 配置更高上限。高并发会真实消耗模型额度和外部搜索配额，请按自己的服务能力设置。

## English quick overview

OpenClaw sc turns one OpenClaw main agent into a high-throughput control plane:

- 100-task pipelines by default, configurable beyond 100;
- wide web research and large-repository bug audits;
- real multi-core local workers for zero-token search, slicing, stats, and diff;
- completion inboxes that keep fan-out noise out of the human chat;
- separate permissions for main and sub-agents;
- bounded task cards, evidence collection, validation, and failure thresholds.

The public package contains source and contracts—not private logs, credentials, inbox state, service binaries, or machine-specific memory.

## Responsible Use

sc can create substantial outbound request volume when you configure large
fan-out, web search, or many concurrent workers. You are responsible for setting
safe limits and using it only where you have permission.

Before running high-concurrency tasks, configure:

- provider and site rate limits
- maximum fan-out and queue depth
- per-task timeout and retry limits
- allowed domains or file roots
- evidence size limits
- stop conditions and review gates

Do not use sc to overload websites, evade access controls, scrape private data,
or bypass the terms of any service or API provider. The package gives you an
orchestration layer; it does not make unsafe or unauthorized activity acceptable.

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
- Scale search or audit work to dozens or hundreds of bounded lanes when the
  host, provider, network, and task policy allow it.
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

For public or shared deployments, start with low fan-out, short timeouts, narrow
workspace roots, and explicit domain allowlists. Increase concurrency only after
you have measured provider limits, target-system tolerance, and review quality.

## License

Business Source License 1.1. See `LICENSE`.
