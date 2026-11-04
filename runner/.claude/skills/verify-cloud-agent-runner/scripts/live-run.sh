#!/usr/bin/env bash
# Usage: live-run.sh <harness> <model> <image> <outdir> [prompt-file]
# One real `cloud-agent run` against alaborderie/cloud-agent-runner-sandbox, on a new branch.
# Credentials come from the environment. On Jarvis, a missing one is read from the local
# CLI stores without printing it. Writes prompt.md, events.jsonl, raw.jsonl, stderr.log to <outdir>,
# validates events.jsonl, and fails if any credential value appears in the output files.
set -euo pipefail
harness=$1 model=$2 image=$3 out=$4 prompt=${5:-}
here="$(cd "$(dirname "$0")" && pwd)"
runner="$(cd "$here/../../../.." && pwd)"
mkdir -p "$out" && chmod 777 "$out"
stamp="$(date +%Y%m%d-%H%M%S)-$$"
branch="test/${harness}-${stamp}"
if [ -n "$prompt" ]; then
  cp "$prompt" "$out/prompt.md"
else
  cat > "$out/prompt.md" <<PROMPT
You are exercising a headless agent runner. Keep it short and do exactly this:
1. Call the ask_user tool once, with blocking set to false, asking "Which greeting should the file contain?" with the options "hello" and "bonjour". Proceed with "hello".
2. Create the file hello-${harness}.txt containing the line "hello from ${harness}".
3. Run \`git status --short\` in the shell.
4. Commit with the message "test: add hello-${harness}.txt", push the current branch to origin, and open a pull request against main with \`gh pr create --fill --base main\`.
5. Reply with the pull request URL and nothing else.
PROMPT
fi

export GH_TOKEN="${GH_TOKEN:-$(gh auth token)}"
args=(-e GH_TOKEN -v "$out:/out")
secrets=("$GH_TOKEN")
case "$harness" in
  claude)
    export CLAUDE_CODE_OAUTH_TOKEN="${CLAUDE_CODE_OAUTH_TOKEN:-$(jq -r .claudeAiOauth.accessToken ~/.claude/.credentials.json)}"
    args+=(-e CLAUDE_CODE_OAUTH_TOKEN); secrets+=("$CLAUDE_CODE_OAUTH_TOKEN") ;;
  codex)
    if [ -n "${CODEX_API_KEY:-}" ]; then
      args+=(-e CODEX_API_KEY); secrets+=("$CODEX_API_KEY")
    else
      mkdir -p "$out/codex-secret"
      cp ~/.codex/auth.json "$out/codex-secret/auth.json" && chmod 644 "$out/codex-secret/auth.json"
      args+=(-e CODEX_AUTH_JSON=/var/run/secrets/codex/auth.json -v "$out/codex-secret:/var/run/secrets/codex:ro")
      while IFS= read -r t; do secrets+=("$t"); done < <(jq -r '.tokens | .access_token, .refresh_token, .id_token' ~/.codex/auth.json)
    fi ;;
  opencode)
    export OPENCODE_API_KEY="${OPENCODE_API_KEY:-$(opencode auth export 2>/dev/null | jq -r '[.[] | select(.integrationID=="opencode-go" and .active)][0].value.key')}"
    args+=(-e OPENCODE_API_KEY); secrets+=("$OPENCODE_API_KEY") ;;
  *) echo "unknown harness $harness" >&2; exit 2 ;;
esac

set +e
docker run --rm --name "cloud-agent-${harness}-${stamp}" "${args[@]}" "$image" run \
  --harness "$harness" --model "$model" --effort high \
  --repo alaborderie/cloud-agent-runner-sandbox --base main --branch "$branch" \
  --prompt-file /out/prompt.md --raw-out /out/raw.jsonl --run-id "verify-${harness}-${stamp}" \
  > "$out/events.jsonl" 2> "$out/stderr.log"
code=$?
set -e
rm -rf "$out/codex-secret"
docker run --rm -v "$out:/out" --entrypoint sh "$image" -c 'chmod a+r /out/raw.jsonl 2>/dev/null' || true
echo "exit=$code branch=$branch"
leaks=0
for s in "${secrets[@]}"; do
  [ -n "$s" ] && grep -lF -- "$s" "$out/events.jsonl" "$out/stderr.log" "$out/raw.jsonl" && leaks=1
done
echo "credential leaks: $leaks"
node "$runner/scripts/validate-events.ts" "$out/events.jsonl"
jq -c 'select(.type=="run.finished") | {status, exit_code, pushed, pr_url, open_questions, error}' "$out/events.jsonl"
[ "$leaks" = 0 ]
