---
name: verify-cloud-agent-runner
description: Prove a change to the cloud-agent runner image (runner/ in backstage-plugin-cloud-agents) by building the image, running `cloud-agent doctor`, and running real headless Claude Code, Codex, or OpenCode agents against the sandbox repo, then validating the event stream. Use after any change to runner/ or .github/workflows/runner.yml, or when a run, the event stream, or the skills install looks wrong.
---

# Verify the cloud-agent runner

The product is a container image. Its user is the Backstage plugin, which starts `cloud-agent run` in a Kubernetes Job and reads the JSONL events on stdout. Drive it the same way: `docker run` the image, then read stdout, the exit code, and the GitHub side effects (branch, pull request).

All commands run from `runner/`. Every run creates a branch and usually a pull request in the public throwaway repo `alaborderie/cloud-agent-runner-sandbox`. Nothing else is written outside the output directory.

## Launch

```sh
cd runner
pnpm install
docker build -t cloud-agent-runner:dev --build-arg CLOUD_AGENT_VERSION=0.1.0-dev .
```

Ready means `docker run --rm cloud-agent-runner:dev version` prints `0.1.0-dev`. To test the published image instead, use `ghcr.io/alaborderie/cloud-agent-runner:latest` (or `:sha-<commit>`) wherever these steps say `cloud-agent-runner:dev`.

## Doctor

```sh
GH_TOKEN="$(gh auth token)" docker run --rm -e GH_TOKEN cloud-agent-runner:dev doctor
```

Expect exit 0 and `"ok": true`. For each of `claude`, `codex`, and `opencode`, the report shows `version` and `skills` with `t3-hub`, `poteto-mode`, and `full-send` all `true`, and `skills_commit` is a 40-hex SHA. The check calls no model and passes no harness credential. Without `GH_TOKEN`, `skills_error` says why, and every skill is `false`.

## Drive

[`scripts/live-run.sh`](scripts/live-run.sh) runs one real agent:

```sh
.claude/skills/verify-cloud-agent-runner/scripts/live-run.sh <harness> <model> <image> <outdir> [prompt-file]
```

| Harness | Model | Credential (env, else read from Jarvis's local CLI login) |
| --- | --- | --- |
| `claude` | `claude-opus-5-5` | `CLAUDE_CODE_OAUTH_TOKEN`, else `~/.claude/.credentials.json` |
| `codex` | `gpt-6.1-sol` | `CODEX_API_KEY`, else `~/.codex/auth.json` mounted as `CODEX_AUTH_JSON` |
| `opencode` | `opencode-go/deepseek-v4.1-flash` | `OPENCODE_API_KEY`, else the active OpenCode Go key from `opencode auth export` |

`GH_TOKEN` defaults to `gh auth token`. The script never prints a credential. Without a prompt file, the agent asks one non-blocking `ask_user` question, writes `hello-<harness>.txt`, pushes, and opens a pull request. Runs on different harnesses can go in parallel. Each gets its own branch and container name.

The Claude access token in `~/.claude/.credentials.json` lasts a few hours. If a Claude run fails with an auth error, run any local `claude` command to refresh it.

## Evidence

The script leaves these files in `<outdir>` and keeps them:

- `events.jsonl`, the event stream. The script validates it with `scripts/validate-events.ts` (stream rules plus the JSON Schema).
- `raw.jsonl`, the harness's native output, redacted. Copy it to `test/fixtures/<harness>/` to add a translator fixture.
- `stderr.log`, the harness and skills-install logs.
- `prompt.md`.

It prints `exit=<code>`, the leak check (`credential leaks: 0` is required), the validator result, and the `run.finished` summary. A proof of a change to the stream also shows the events the change affects (`jq -c . events.jsonl`), and for a successful run, the pull request in the sandbox repo (`gh pr view <url>`).

## Cleanup

Each container runs with `--rm`. The sandbox branches and pull requests are evidence, so leave them unless asked. To close a test pull request: `gh pr close <number> --repo alaborderie/cloud-agent-runner-sandbox --delete-branch`. Stop a stuck run by its container name, `cloud-agent-<harness>-<stamp>`, never by process name.

## Features

[`features/README.md`](features/README.md) lists the user-facing features and how to prove each one.
