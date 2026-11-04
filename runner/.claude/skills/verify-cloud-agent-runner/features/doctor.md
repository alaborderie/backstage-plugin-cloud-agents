# Doctor

## Sub-features

- Install the skills with `GH_TOKEN`.
- For each harness, report the CLI version and whether each requested skill is visible.
- Report `git`, `gh`, `node`, and `python3` versions.

## How to get to it (user POV)

`docker run --rm -e GH_TOKEN <image> doctor`, optionally with `--skill <name>` (repeatable) or `--skip-skills-install`.

## Driving it with docker

```sh
GH_TOKEN="$(gh auth token)" docker run --rm -e GH_TOKEN cloud-agent-runner:dev doctor
```

Pass: exit 0, `"ok": true`, and every `harnesses.<h>.skills` value `true`. The `evidence` field says how each harness was checked.

## Gotchas

- Without `GH_TOKEN`, the private skills repo is not fetched, so `ok` is `false` and `skills_error` explains it.
- The Claude Code check relies on the `init` event that `claude -p` prints before it needs a login. If a Claude Code update changes that, `evidence` reads `no init event`.
