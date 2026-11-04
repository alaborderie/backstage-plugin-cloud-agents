---
name: verify-cloud-agents-plugin
description: Prove a change to the cloud-agents Backstage plugin (plugins/ in backstage-plugin-cloud-agents) by running the dev backend and dev app against a local kind cluster, launching one real OpenCode agent on alaborderie/cloud-agent-runner-sandbox through the API and through the browser UI, and checking the event stream, its replay, a Backstage restart mid-run, and the database and logs for leaked credentials. Use after any change to plugins/, docs/API.md, or .github/workflows/plugins.yml, or when an agent, the event stream, or the settings page looks wrong.
---

# Verify the cloud-agents plugin

The product is two Backstage plugins and their API. Their users are a person in the Backstage UI and an external client (the T3 bridge) with a `cat_` token. Drive both: the API with `curl` and a `cat_` token, the UI with Playwright as the guest user. Every agent run creates a branch and a pull request in the public throwaway repository `alaborderie/cloud-agent-runner-sandbox`.

All paths below are relative to the repository root. `scripts/` means `plugins/.claude/skills/verify-cloud-agents-plugin/scripts/`.

## Launch

1. Cluster. Use a kubeconfig file of its own, so the user's current context stays unchanged:

   ```sh
   kind create cluster --name cloud-agents --kubeconfig ~/.kube/kind-cloud-agents   # once
   export KUBECONFIG=~/.kube/kind-cloud-agents
   kubectl create namespace cloud-agents                                            # once
   ```

   Loading the runner image saves a 600 MB pull per node restart: `kind load docker-image ghcr.io/alaborderie/cloud-agent-runner:sha-de01b1b --name cloud-agents`. If `kind load` fails with "disk quota exceeded", set `TMPDIR` to a directory under `$HOME`.

For RBAC verification, follow the README's [restricted Role setup](../../../../README.md#verify-with-the-restricted-role) before starting the backend. Use the generated ServiceAccount `KUBECONFIG` for both the initial backend and the e2e shell, then run `VERIFY_KUBE_RBAC=1 scripts/e2e.sh …`. This checks every required verb and rejects administrator access. Use a separate administrator shell for setup and cleanup because the backend Role cannot list Jobs.

2. Backend, from a shell that keeps these variables, because the restart check starts the backend again from that shell:

   ```sh
   corepack enable && yarn install
   export CLOUD_AGENTS_RUNNER_IMAGE=ghcr.io/alaborderie/cloud-agent-runner:sha-de01b1b
   export CLOUD_AGENTS_ENCRYPTION_KEY="$(cat <key file>)"   # keep one key; a new key makes stored credentials unreadable
   yarn start:backend > <log> 2>&1 &
   ```

   Ready means `curl -sf http://localhost:7007/.backstage/health/v1/readiness` succeeds and the log has `Cloud agents run in namespace cloud-agents`.

3. App, only for the UI check: `BROWSER=none yarn start:frontend > <log> 2>&1 &`. Ready means `curl -sf http://localhost:3000/cloud-agents` answers 200.

## Doctor

```sh
curl -sf http://localhost:7007/.backstage/health/v1/readiness && kubectl -n cloud-agents get jobs
curl -s http://localhost:7007/api/auth/guest/refresh -H 'X-Requested-With: XMLHttpRequest' | jq -r .backstageIdentity.identity.userEntityRef
```

Expect `{"status":"ok"}`, a job list (possibly empty), and `user:development/guest`. If the backend log says `The cloud-agents encryption key must be base64 of 32 bytes` or `runnerImage ... is required`, the env vars are missing in the backend's shell.

## Drive

| Script                                                | What it proves                                                                                                                                                                                                                                                                                                                                                                                                                                |
| ----------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `scripts/e2e.sh <outdir> [backend-url] [backend-log]` | Through the API with a `cat_` token: sets the OpenCode Go key and a GitHub token, starts a `flash` agent, follows `GET /agents/:id/events` to the end, drops a second reader after 8 messages and resumes it with `Last-Event-ID`, replays from 0 and from the middle, and checks that the agent `succeeded` with a `prUrl`. Then it searches the SQLite dump, the stored events, the streams, and the backend log for the credential values. |
| `RESTART_BACKEND=1 scripts/e2e.sh …`                  | The same, and it stops the dev backend after the eighth message and starts it again. The resumed stream must equal a full replay, and each run's runner seqs must run 0..n once each.                                                                                                                                                                                                                                                         |
| `scripts/ui.mjs <outdir> [app-url]`                   | In headless Chromium: clears, sets, and clears again each credential on the settings page, creates and deletes a token, starts an agent from the New agent form, and waits on the agent page for "Agent succeeded" and the pull request link. Needs `OPENCODE_API_KEY`, `GH_TOKEN`, and `PLAYWRIGHT` (path to a `playwright` package whose Chromium is installed).                                                                            |
| `scripts/sse.mjs summary\|compare\|join`              | Parses saved SSE streams; the scripts above call it.                                                                                                                                                                                                                                                                                                                                                                                          |

Credentials come from `OPENCODE_API_KEY` and `GH_TOKEN`, else from `opencode auth export` (the active `opencode-go` key) and `gh auth token`. No script prints a credential.

The feature map is in [features/README.md](features/README.md).

## Evidence

`e2e.sh` keeps in `<outdir>`: `agent-created.json`, `agent-final.json`, `credentials.json`, `stream-full.sse`, `stream-part1.sse`, `stream-part2.sse`, `stream-resumed.sse`, `stream-replay-all.sse`, `stream-replay.sse`, `summary.json`, `db-dump.sql`, and `stored-events.jsonl`. It prints one `ok` line per check and `checked N files for 3 credential values: leaks=0`, and exits non-zero on any failure. `ui.mjs` keeps screenshots (`settings-all-set.png`, `settings-all-cleared.png`, `agent-running.png`, `agent-succeeded.png`, `agents-list.png`, or `failure.png`) and `ui-agent.json` with the agent URL and pull request. A proof of a change quotes the `ok` lines, the final agent JSON, and the pull request (`gh pr view <url> --repo alaborderie/cloud-agent-runner-sandbox`).

## Cleanup

Stop only what you started: kill the backend and app processes by the PIDs whose working directory is `plugins/cloud-agents-backend` or `plugins/cloud-agents`, not by name. `kubectl -n cloud-agents delete jobs --all` removes the Jobs and, through the owner references, their Secrets. `kind delete cluster --name cloud-agents` removes the cluster. The SQLite files in `plugins/cloud-agents-backend/.sqlite/` hold the dev data; delete them for a clean start. Close the sandbox pull requests the runs opened if they clutter the repository. The evidence directories stay.
