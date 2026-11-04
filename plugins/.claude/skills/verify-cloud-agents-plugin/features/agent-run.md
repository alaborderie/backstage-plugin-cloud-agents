# Agent runs and their event stream

## Sub-features

- `POST /agents` with `tier`, or with `harness` and `model`; `422 missing_credential` without the harness or GitHub credential.
- One suspended Job and an owned Secret per run; the Secret holds only `GH_TOKEN`, the harness credential, and `prompt.md`.
- `GET /agents/:id/events`: replay after `Last-Event-ID` or `?after=`, then live events, then close on a terminal `agent.status`.
- Resume after a Backstage restart from the stored runner seq.
- `prUrl` on the agent from `run.finished.pr_url`.
- The agent page in the UI: summary, runs, live timeline.

## How to get to it (user POV)

API: `POST /api/cloud-agents/agents` with a `cat_` token. UI: **Cloud agents > New agent**, then the agent page `/cloud-agents/agents/<id>`.

## Driving it with curl and Playwright

`scripts/e2e.sh <outdir> http://localhost:7007 <backend-log>`, and with `RESTART_BACKEND=1` for the restart. `scripts/ui.mjs <outdir>` for the UI. While a run goes, `kubectl -n cloud-agents get jobs,pods,secrets` shows one Job, one pod, and one Secret with 3 keys.

## Gotchas

- The pod log carries the runner's stderr too. The backend logs each skipped non-JSON line at debug level; a warn `runner seq jumped` means an event line was lost.
- A Job deleted by hand removes its Secret too, through the owner reference (checked on kind 1.37 with `--cascade=background`).
- OpenCode runs on `flash` take about 30 s; the restart check adds a 45 s `sleep` to the prompt so the restart lands mid-run.
