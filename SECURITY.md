# Security

sc is an OpenClaw plugin that can route local files, web search, memory lookup,
worker tasks, and sub-agent jobs. Treat prompts, task files, logs, memory
records, inbox events, screenshots, and API keys as sensitive.

## Do Not Commit

- `.env` or `.env.*`
- `openclaw.json` or private runtime configuration
- `logs/`, `tools/logs/`, `tools/sidecar/logs/`
- `tools/sidecar/inbox/` and `tools/sidecar/tasks/`
- `memory/`, `state/`, `backups/`, `runtime/`, `workspace/`
- request/response dumps, full task reports, private prompts, cookies, tokens,
  API keys, Authorization headers, or private paths

## Runtime Boundaries

The public package excludes local runtime state and bundled service binaries.
Install external tools such as ripgrep through the operating system package
manager, or set `SC_RG_PATH` to a reviewed executable.

## Reporting Issues

Report only redacted reproduction details. Do not include real credentials,
private prompts, raw session logs, task-state JSON, inbox events, or full local
configuration files.
