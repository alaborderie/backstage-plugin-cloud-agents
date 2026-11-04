# Run an agent and stream events

## Sub-features

- Clone `--repo`, then create `--branch` from `--base`, or check out `--branch` when it already exists on the remote.
- Install the skills from `alaborderie/claude-plugins` (`skills.ready`).
- Run the harness headless and translate its output to `session.started`, `assistant.message`, `tool.call`, `tool.result`, `usage`, and `rate_limit` events.
- Report `run.finished` with `pushed`, `head_sha`, and `pr_url`.
- Redact credentials from stdout, stderr, and `--raw-out`.

## How to get to it (user POV)

The Backstage plugin runs `cloud-agent run --harness <h> --model <m> --effort high --repo <owner/name> --base <ref> --branch <name> --prompt-file <path>` in a Job and reads stdout.

## Driving it with live-run.sh

```sh
.claude/skills/verify-cloud-agent-runner/scripts/live-run.sh opencode opencode-go/deepseek-v4.1-flash cloud-agent-runner:dev /tmp/verify/opencode
```

Pass: `exit=0`, `credential leaks: 0`, `ok, N events`, and `run.finished` shows `"status":"succeeded"`, `"pushed":true`, and a `pr_url`. Repeat with `claude claude-opus-5-5` and `codex gpt-6.1-sol` for a change that touches a translator or `src/run.ts`.

## Gotchas

- OpenCode reports a tool only when it finishes, so its `tool.call` and `tool.result` arrive together. OpenCode calls MCP tools through its `execute` tool, so `ask_user` shows up as `execute`.
- A Codex `auth.json` mount must be readable by uid 10001. A mode-600 file owned by your user fails with `EACCES` before `workspace.ready`.
- Usage errors (exit 2) print no events.
