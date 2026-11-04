# Questions, follow-ups, and stop

## Sub-features

- A blocking `ask_user` question ends the run as `needs_input`; the agent lists it in `openQuestions`.
- `POST /agents/:id/reply` records an answer; the last answer starts the next run on the same branch with the original prompt, the questions, and the answers.
- `POST /agents/:id/messages` starts a follow-up run; `409` while a run is active.
- `POST /agents/:id/stop` deletes the Job; the runner reports `cancelled` (exit 130) and the agent becomes `stopped`.
- In the UI: the question card with option chips and an answer box, the follow-up box, and the Stop button.

## How to get to it (user POV)

The agent page `/cloud-agents/agents/<id>`, or the API routes above with a `cat_` token.

## Driving it with curl and Playwright

The backend integration tests (`plugins/cloud-agents-backend/src/plugin.test.ts`) play `runner/test/streams/opencode-needs-input.jsonl` and `opencode-cancelled.jsonl` through the fake Kubernetes API. For a real run, start an agent whose prompt asks a blocking question ("Call ask_user with blocking true and stop"), wait for `needs_input`, then `POST /agents/:id/reply`; for stop, `POST /agents/:id/stop` while the pod runs and watch `kubectl -n cloud-agents get jobs,secrets` empty out.

## Gotchas

- A reply is accepted only while the agent is `needs_input`; a message is accepted in any status but `queued` and `running`.
- After a stop, the stream closes with `run.finished` (`cancelled`) and then `agent.status` `stopped`.
