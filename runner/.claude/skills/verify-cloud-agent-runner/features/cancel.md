# Cancel

## Sub-features

- `SIGTERM` or `SIGINT` to the runner stops the harness with `SIGTERM` and ends the stream with `run.finished` `cancelled`.

## How to get to it (user POV)

Kubernetes deletes the Job's pod, which sends `SIGTERM`.

## Driving it with live-run.sh

```sh
printf '%s\n' 'Run the shell command `sleep 300` and wait for it to finish, then reply "done".' > /tmp/verify/sleep.md
.claude/skills/verify-cloud-agent-runner/scripts/live-run.sh opencode opencode-go/deepseek-v4.1-flash cloud-agent-runner:dev /tmp/verify/cancel /tmp/verify/sleep.md &
until c=$(docker ps --filter name=cloud-agent-opencode --format '{{.Names}}' | head -1) && [ -n "$c" ] && docker exec "$c" pgrep -f 'sleep 300' >/dev/null; do sleep 3; done
docker kill --signal TERM "$c"; wait
```

Pass: `exit=130`, and the last event is `run.finished` with `"status":"cancelled"`.

## Gotchas

- The `sleep` tool call does not appear in the stream, because OpenCode reports a tool only when it finishes.
- The `until` loop picks the first running OpenCode container, so run no other OpenCode verification at the same time.
