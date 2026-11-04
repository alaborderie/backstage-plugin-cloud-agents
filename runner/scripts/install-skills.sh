#!/usr/bin/env bash
# Install Antoine's shared skills for Claude Code, Codex, and OpenCode from the
# private github.com/alaborderie/claude-plugins, at pod start. git reads GitHub
# credentials through gh (GH_TOKEN). Prints the installed commit on stdout;
# everything else goes to stderr.
set -euo pipefail

src="${CLAUDE_PLUGINS_DIR:-/opt/claude-plugins}"
ref="${CLAUDE_PLUGINS_REF:-main}"

if [ -d "$src/.git" ]; then
  git -C "$src" fetch --quiet --depth 1 origin "$ref"
  git -C "$src" checkout --quiet --force FETCH_HEAD
else
  git clone --quiet --depth 1 --branch "$ref" https://github.com/alaborderie/claude-plugins.git "$src"
fi

# Subagents inherit the run's model: the pod only holds the credential for that one provider.
OPENCODE_WORKER_MODEL=inherit bash "$src/sync-opencode.sh" >&2

if claude plugin marketplace list 2>/dev/null | grep -q alaborderie; then
  claude plugin marketplace update alaborderie >&2
  claude plugin update agents@alaborderie >&2
else
  claude plugin marketplace add "$src" >&2
  claude plugin install agents@alaborderie >&2
fi

git -C "$src" rev-parse HEAD
