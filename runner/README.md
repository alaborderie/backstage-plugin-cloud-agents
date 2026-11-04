# cloud-agent-runner

`ghcr.io/alaborderie/cloud-agent-runner` runs one coding agent headless, for example in a Kubernetes Job. It clones a GitHub repository and checks out a branch. It runs Claude Code, Codex, or OpenCode with Antoine's shared skills, and prints the agent's work as a versioned JSONL event stream on stdout. [EVENTS.md](EVENTS.md) is the event contract.

The Backstage plugin in `plugins/` will start one Job per agent with this image. A T3 Code fork will show each agent as a sub-thread from the same stream.

## Run an agent

```sh
docker run --rm \
	-e GH_TOKEN -e OPENCODE_API_KEY \
	-v "$PWD/prompt.md:/prompt.md:ro" \
	ghcr.io/alaborderie/cloud-agent-runner:latest \
	run --harness opencode --model opencode-go/deepseek-v4.1-flash --effort high \
	--repo alaborderie/cloud-agent-runner-sandbox --base main --branch agent/example \
	--prompt-file /prompt.md > events.jsonl
```

The image accepts `run`, `doctor`, `version`, and `help` with or without a leading `cloud-agent`. Any other command runs as is, so `docker run IMAGE bash` opens a shell.

### `cloud-agent run`

| Option | Required | Meaning |
| --- | --- | --- |
| `--harness` | yes | `claude`, `codex`, or `opencode`. |
| `--model` | yes | The harness's model slug, unchanged: for example `claude-opus-5-5`, `gpt-6.1-sol`, or `opencode-go/deepseek-v4.1-flash`. |
| `--effort` | yes | A reasoning level such as `high`. |
| `--repo` | yes | `owner/name` on github.com. |
| `--base` | yes | The branch or commit to start a new branch from. |
| `--branch` | yes | The branch the agent works on. If it exists on the remote, the runner checks it out instead of creating it, so a retry or a follow-up run continues the same work. |
| `--prompt-file` | yes | A file with the prompt, for example `/poteto-mode <brief>` and then `/full-send`. |
| `--workdir` | no | Where to clone. Default `$CLOUD_AGENT_WORKDIR`, else `/workspace/<repo name>`. |
| `--run-id` | no | Default `$CLOUD_AGENT_RUN_ID`, else a random UUID. |
| `--raw-out` | no | Also write the harness's native output to this file, with credentials redacted. Use it to record test fixtures. |
| `--skip-skills-install` | no | Use the skills already installed instead of fetching them. For local development only. |

The exit code is 0 for `succeeded`, 1 for `failed`, 2 for a usage error, 3 for `needs_input`, and 130 for `cancelled`.

The runner tells the harness to run without permission prompts. Claude Code gets `--permission-mode bypassPermissions`, Codex gets `--dangerously-bypass-approvals-and-sandbox`, and OpenCode gets `--auto`. The container is the sandbox.

## Credentials

Each credential arrives as an environment variable from the agent's Kubernetes Secret.

| Variable | Used by | Notes |
| --- | --- | --- |
| `GH_TOKEN` | git, `gh`, the skills install, and the agent | Required. It must read the private `alaborderie/claude-plugins` and push to `--repo`. git gets it through `gh auth setup-git`, so the token never appears in a remote URL. |
| `CLAUDE_CODE_OAUTH_TOKEN` | `--harness claude` | The token from `claude setup-token`. Only the official Claude Code CLI receives it. |
| `CODEX_API_KEY` or `OPENAI_API_KEY` | `--harness codex` | An OpenAI API key. Preferred for unattended pods. |
| `CODEX_AUTH_JSON` | `--harness codex` | The path of a ChatGPT `auth.json`, mounted from a Secret. The runner copies it to `~/.codex/auth.json`. Give the mount a mode the container user (uid 10001) can read, such as `defaultMode: 0444`. |
| `OPENCODE_API_KEY` | `--harness opencode` | An OpenCode Go API key from the OpenCode console. |

Each harness process gets `GH_TOKEN` and its own credential only. Claude Code never sees an OpenAI or OpenCode key, and Codex and OpenCode never see `CLAUDE_CODE_OAUTH_TOKEN`. The skills install and `doctor`'s probes get no harness credential. The runner redacts every credential value from stdout, stderr, and `--raw-out` (see [EVENTS.md](EVENTS.md#credentials)). The image contains no credentials.

A ChatGPT `auth.json` holds a refresh token. If Codex refreshes it during a run, the copy in the Secret can stop working, because the refreshed token exists only in the pod. Use an API key for Jobs, or re-export `auth.json` when Codex reports a login error.

## Skills

At the start of every run, the runner installs the skills from the private [`alaborderie/claude-plugins`](https://github.com/alaborderie/claude-plugins) at `main` (`$CLAUDE_PLUGINS_REF` overrides the ref). [`scripts/install-skills.sh`](scripts/install-skills.sh) does three things:

1. It clones the repository into `/opt/claude-plugins`, or updates the clone.
2. It runs `sync-opencode.sh` with `OPENCODE_WORKER_MODEL=inherit`. That script installs every skill into `~/.agents/skills`, links `~/.claude/skills` to it, and generates the OpenCode agents. With `inherit`, OpenCode subagents use the run's model, because the pod holds no other provider's credential.
3. It installs the Claude Code plugin `agents@alaborderie` from that clone, for its agents and its session-start hook.

The `skills.ready` event reports the installed commit. If the install fails, the run fails. The image does not contain the skills, because the repository is private and the image is public.

## Check the image with `doctor`

```sh
docker run --rm -e GH_TOKEN ghcr.io/alaborderie/cloud-agent-runner:latest doctor
```

`doctor` installs the skills (it needs `GH_TOKEN`), then prints a JSON report and exits 0 when every check passes. For each harness, it reports the CLI version and whether `t3-hub`, `poteto-mode`, and `full-send` are visible to it. `--skill <name>` checks other skills. The checks send no credential and call no model.

| Harness | How `doctor` reads the skill list |
| --- | --- |
| Claude Code | `claude -p --output-format stream-json --verbose` prints its `init` event, which lists skills and plugins, before it needs a login. |
| Codex | `codex debug prompt-input` prints the model-visible prompt, which lists each skill's `SKILL.md`. |
| OpenCode | `opencode run` sends its first request to a fake model server inside `doctor`. The request lists the skills. |

## Prompts that use skills

A prompt file can start with a slash command, such as `/poteto-mode <brief>`. In the sandbox runs on 2026-11-04, each harness acted on it differently:

- Claude Code expands the slash command into the skill's text.
- Codex reads `~/.agents/skills/<name>/SKILL.md` with a shell command.
- OpenCode loads skills with its `skill` tool.

## What `/poteto-mode` and `/full-send` cannot do in a pod

The skills assume Jarvis: T3 Code, a human who answers, and an agent that someone wakes again later. In the pod, some steps fail and some only partly work. The skills are unchanged. The file and line references are to `alaborderie/claude-plugins` at commit `b788b90`.

These steps fail:

- **Review by GPT Sol.** `full-send` runs `sol-loop`, which needs a GPT Sol reviewer through T3's `delegate_task` or a native Sol subagent, and forbids another model (`skills/sol-loop/SKILL.md`, "Start Sol"). A Claude Code or OpenCode pod has no OpenAI credential, so the merge gate in `plugins/agents/rules/git-workflow.md` cannot pass. The agent then leaves the PR open and unmerged, as `full-send`'s "Asking the user" section says. A Codex pod can start a Sol subagent if its account offers Sol (not tested).
- **Waiting for the PR.** `full-send` says to stay active until the merge, and `babysit-pr` waits with T3's `watch_pull_request` or with `scripts/pr-wait` under Claude Code's Monitor tool, and ends its turn between events. In the pod, the run ends when the agent ends its turn, and nothing starts it again. The agent can only wait inside one long shell command, within the harness's command timeout.
- **Asking the user.** No human answers in the pod. `AskUserQuestion` does not exist in `claude -p`, OpenCode cancels its `question` tool, and Codex has no `request_user_input` in `exec`. The `ask_user` tool records the question (see [EVENTS.md](EVENTS.md#questions)), and the agent stops at an open, unmerged PR.
- **Proof that needs a browser or Docker.** The image has no browser, no Playwright browsers, and no Docker. A web UI change, or an app that needs Docker services, cannot be proven the way `full-send`'s "Proof" section asks, so the agent stops before the merge. CLI and HTTP checks work.

These steps only partly work:

- **T3 tools.** `delegate_task`, `watch_pull_request`, `link_pull_request`, `html_render`, and the other T3 MCP tools do not exist. The skills fall back to `gh` and to native subagents.
- **Subagent models.** pstack's default subagent models (`grok-*` and `claude-opus-*` slugs) and `~/.claude/rules/pstack-models.md` are absent. Claude Code maps them through the plugin's stack overrides. Codex and OpenCode fall back to their own models, so multi-model panels (`architect`, `arena`, `interrogate`) use one model family.
- **Stack overrides in Codex.** Claude Code and OpenCode load `plugins/agents/rules/stack-overrides.md` through a session hook. Codex has no session hook, so a Codex agent follows pstack's text alone, which delegates more.
- **Deploy checks after a merge.** `rules/deployment.md` asks for `kubectl rollout status`. The image has no `kubectl`, so the agent reports a deploy as "live unverified".
- **Wake-ups and local notes.** `/loop`, `ScheduleWakeup`, and notes kept outside the repository (decision trails, pause notes in `/tmp`) end with the pod.
- **Jarvis services.** Laya, the local image server, and the local LLM server are not reachable.

## Image contents

| Component | Version | Source |
| --- | --- | --- |
| Base image | `node:24.22.2-bookworm-slim`, pinned by digest | Docker Hub |
| Claude Code | 2.1.318 | npm `@anthropic-ai/claude-code` |
| Codex CLI | 0.166.0 | npm `@openai/codex` |
| OpenCode | 2.2.5 | GitHub release `opencode-linux-x64.tar.gz`, SHA-256 checked |
| GitHub CLI | 2.103.3 | GitHub release, SHA-256 checked |
| pnpm | 12.16.1 | npm |
| git, python3, jq, ripgrep, curl, tini | Debian bookworm | apt |

The image runs as the non-root user `agent` (uid 10001) with `HOME=/home/agent`. It is built for `linux/amd64` only. To update a CLI, change its `ARG` in the [Dockerfile](Dockerfile) (and the SHA-256 for a GitHub release), then rerun `doctor` and a real run for that harness.

## Develop

```sh
cd runner
pnpm install
pnpm typecheck && pnpm lint && pnpm test
docker build -t cloud-agent-runner:dev .
```

The runner is TypeScript that Node 24 runs directly, with no build step and no runtime dependencies. `src/harnesses/` holds one module per harness: its command line, its credential, and the translator from its native output to events. The tests feed the native output in `test/fixtures/` through each translator and validate every event against the schema. `test/streams/` holds the event streams of real runs against [`alaborderie/cloud-agent-runner-sandbox`](https://github.com/alaborderie/cloud-agent-runner-sandbox).

To validate a stream file:

```sh
node scripts/validate-events.ts events.jsonl
```

To record a new fixture, run with `--raw-out /out/raw.jsonl` and copy the file to `test/fixtures/<harness>/`.

`.github/workflows/runner.yml` runs these checks and builds the image on each pull request that touches `runner/`. On `main`, it pushes `latest` and `sha-<commit>` to GHCR.
