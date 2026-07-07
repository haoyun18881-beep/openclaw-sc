# sc install notes

1. Install Node.js 22 or newer.
2. Run `npm install` and `npm run lint`.
3. Copy this directory to `%USERPROFILE%\.openclaw\workspace\plugins\sc`.
4. Enable the `sc` plugin in OpenClaw plugin configuration.
5. Keep real `.env`, logs, inbox events, task files, and local OpenClaw memory
   outside the public repository.

Optional tools:

- Install ripgrep as `rg`, or set `SC_RG_PATH`.
- Set provider keys through environment variables only.
