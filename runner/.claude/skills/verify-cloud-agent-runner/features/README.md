# cloud-agent runner features

| Feature | File | Proof in one line |
| --- | --- | --- |
| Run an agent and stream events | [run.md](run.md) | `live-run.sh` with no prompt file exits 0, the stream validates, and `run.finished.pr_url` is a sandbox pull request. |
| Doctor | [doctor.md](doctor.md) | `doctor` exits 0 with all three skills visible to all three harnesses. |
| Questions | [questions.md](questions.md) | A blocking `ask_user` ends the run as `needs_input` with exit 3. |
| Cancel | [cancel.md](cancel.md) | `SIGTERM` to the container ends the run as `cancelled` with exit 130. |
