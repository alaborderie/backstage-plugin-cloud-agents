# Questions

## Sub-features

- `ask_user` (MCP server `cloud_agent`) reports the question to the runner over a Unix socket, and the runner emits a `question` event with `source: "ask_user"` and id `ask-N`.
- A native question tool (Claude Code `AskUserQuestion`, OpenCode `question`) also produces a `question` event with `source: "native"`.
- A blocking question ends the run as `needs_input` (exit 3) with the id in `open_questions`.

## How to get to it (user POV)

The agent calls `ask_user`. The operator reads the `question` event and answers by starting a follow-up run on the same branch.

## Driving it with live-run.sh

```sh
printf '%s\n' 'Call the ask_user tool once with blocking set to true, asking "Should I delete README.md?" with the options "yes" and "no". Then stop and end your turn without doing anything else.' > /tmp/verify/blocking.md
.claude/skills/verify-cloud-agent-runner/scripts/live-run.sh opencode opencode-go/deepseek-v4.1-flash cloud-agent-runner:dev /tmp/verify/blocking /tmp/verify/blocking.md
```

Pass: `exit=3`, and `run.finished` shows `"status":"needs_input"` and `"open_questions":["ask-1"]`.

## Gotchas

- OpenCode sometimes tries its native `question` tool first. That adds a `native` question event, which never blocks.
