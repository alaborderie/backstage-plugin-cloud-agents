#!/usr/bin/env bash
# Usage: [RESTART_BACKEND=1] e2e.sh <outdir> [backend-url] [backend-log]
# Drives a running dev backend (README "Develop") the way the T3 bridge does: a guest Backstage
# token creates a cat_ token, the cat_ token stores the OpenCode Go key and a GitHub token, launches
# one OpenCode agent on alaborderie/cloud-agent-runner-sandbox, follows GET /agents/:id/events, drops
# the connection mid-run and resumes with Last-Event-ID, replays the finished stream, and greps the
# database dump, the backend log, and the stored events for the credential values.
# With RESTART_BACKEND=1 it also stops the dev backend mid-run and starts it again (`yarn
# start:backend`, output appended to <backend-log>), so the resumed stream proves the follower
# picked the run up from the stored seq. Run it from a shell with the dev env vars set.
# Credentials come from OPENCODE_API_KEY and GH_TOKEN, else from `opencode auth export` and
# `gh auth token`. Nothing prints a credential.
set -euo pipefail
out=$1
base=${2:-http://localhost:7007}
log=${3:-}
here="$(cd "$(dirname "$0")" && pwd)"
repo_root="$(cd "$here/../../../../.." && pwd)"
db="$repo_root/plugins/cloud-agents-backend/.sqlite/cloud-agents.sqlite"
api="$base/api/cloud-agents"
mkdir -p "$out"
umask 077

if [ "${VERIFY_KUBE_RBAC:-}" = 1 ]; then
  : "${KUBECONFIG:?Set KUBECONFIG to the ServiceAccount kubeconfig used by the backend}"
  ns="${CLOUD_AGENTS_NAMESPACE:-cloud-agents}"
  for permission in 'create jobs.batch' 'get jobs.batch' 'patch jobs.batch' 'delete jobs.batch' 'create secrets' 'list pods' 'list events'; do
    read -r verb resource <<< "$permission"
    kubectl -n "$ns" auth can-i "$verb" "$resource" --quiet || { echo "missing $permission in $ns" >&2; exit 1; }
  done
  kubectl -n "$ns" auth can-i get pods --subresource=log --quiet || { echo "missing get pods/log in $ns" >&2; exit 1; }
  for permission in 'list jobs.batch' 'get secrets'; do
    read -r verb resource <<< "$permission"
    if kubectl -n "$ns" auth can-i "$verb" "$resource" --quiet; then
      echo "verification requires restricted access; unexpectedly allowed $permission in $ns" >&2
      exit 1
    fi
  done
  echo "ok: ServiceAccount permissions match the README Role checks"
fi

OPENCODE_API_KEY="${OPENCODE_API_KEY:-$(opencode auth export 2>/dev/null | jq -r '[.[] | select(.integrationID=="opencode-go" and .active)][0].value.key')}"
GH_TOKEN="${GH_TOKEN:-$(gh auth token)}"
[ -n "$OPENCODE_API_KEY" ] && [ "$OPENCODE_API_KEY" != null ] || { echo "no OpenCode Go key" >&2; exit 1; }

guest=$(curl -sf "$base/api/auth/guest/refresh" -H 'X-Requested-With: XMLHttpRequest' | jq -r .backstageIdentity.token)
curl -sf -X POST "$api/me/tokens" -H "Authorization: Bearer $guest" -H 'Content-Type: application/json' \
  -d '{"name":"verify-cloud-agents-plugin"}' > "$out/token.json"
cat_token=$(jq -r .token "$out/token.json")
auth=(-H "Authorization: Bearer $cat_token")
echo "cat_ token $(jq -r .id "$out/token.json") created"

jq -n --arg v "$OPENCODE_API_KEY" '{value: $v}' | curl -sf -X PUT "$api/me/credentials/opencode" "${auth[@]}" -H 'Content-Type: application/json' --data @- > /dev/null
jq -n --arg v "$GH_TOKEN" '{value: $v}' | curl -sf -X PUT "$api/me/credentials/github" "${auth[@]}" -H 'Content-Type: application/json' --data @- > /dev/null
curl -sf "$api/me/credentials" "${auth[@]}" | tee "$out/credentials.json" | jq -c '{opencode: .opencode.set, github: .github}'

stamp=$(date +%Y%m%d-%H%M%S)
prompt="You are exercising the cloud-agents Backstage plugin. Keep it short and do exactly this:
1. Run \`sleep 45\` in the shell, so the run lasts long enough to restart Backstage during it.
2. Call the ask_user tool once, with blocking set to false, asking \"Which greeting should the file contain?\" with the options \"hello\" and \"bonjour\". Proceed with \"hello\".
3. Create the file plugin-e2e-${stamp}.txt containing the line \"hello from the cloud-agents plugin\".
4. Commit with the message \"test: add plugin-e2e-${stamp}.txt\", push the current branch to origin, and open a pull request against main with \`gh pr create --fill --base main\`.
5. Reply with the pull request URL and nothing else."
jq -n --arg p "$prompt" --arg t "plugin e2e $stamp" \
  '{repo: "alaborderie/cloud-agent-runner-sandbox", base: "main", tier: "flash", title: $t, prompt: $p, parent: {source: "verify"}}' \
  | curl -sf -X POST "$api/agents" "${auth[@]}" -H 'Content-Type: application/json' --data @- > "$out/agent-created.json"
id=$(jq -r .id "$out/agent-created.json")
echo "agent $id status $(jq -r .status "$out/agent-created.json") branch $(jq -r .branch "$out/agent-created.json")"

# One reader stays connected to the end. A second one drops after 8 messages and resumes with Last-Event-ID.
curl -sN --max-time 1800 "$api/agents/$id/events" "${auth[@]}" > "$out/stream-full.sse" &
full_pid=$!
curl -sN --max-time 1800 "$api/agents/$id/events" "${auth[@]}" > "$out/stream-part1.sse" &
part_pid=$!
until [ "$(grep -c '^id: ' "$out/stream-part1.sse" || true)" -ge 8 ] || ! kill -0 "$full_pid" 2>/dev/null; do sleep 1; done
kill "$part_pid" 2>/dev/null || true
wait "$part_pid" 2>/dev/null || true
last_id=$(grep '^id: ' "$out/stream-part1.sse" | tail -1 | cut -d' ' -f2)
# Drop a trailing partial message, if the kill cut one.
node -e 'const fs=require("fs");const f=process.argv[1];const s=fs.readFileSync(f,"utf8");fs.writeFileSync(f,s.slice(0,s.lastIndexOf("\n\n")+2))' "$out/stream-part1.sse"
last_id=$(grep '^id: ' "$out/stream-part1.sse" | tail -1 | cut -d' ' -f2)
echo "dropped the second reader at seq $last_id"
if [ "${RESTART_BACKEND:-}" = 1 ]; then
  backend_dir="$repo_root/plugins/cloud-agents-backend"
  pids=$(for p in /proc/[0-9]*; do if [ "$(readlink "$p/cwd" 2>/dev/null)" = "$backend_dir" ]; then basename "$p"; fi; done)
  [ -n "$pids" ] || { echo "no dev backend process runs in $backend_dir" >&2; exit 1; }
  kill $pids
  while curl -sf -o /dev/null "$base/.backstage/health/v1/readiness"; do sleep 1; done
  echo "stopped the backend ($(echo $pids | wc -w) processes) while the agent runs"
  (cd "$repo_root" && nohup yarn start:backend >> "${log:-/dev/null}" 2>&1 &)
  until curl -sf -o /dev/null "$base/.backstage/health/v1/readiness"; do sleep 2; done
  echo "started the backend again"
fi
echo "resuming with Last-Event-ID: $last_id"
curl -sN --max-time 1800 "$api/agents/$id/events" "${auth[@]}" -H "Last-Event-ID: $last_id" > "$out/stream-part2.sse"
wait "$full_pid" || true
echo "streams closed by the server"
curl -sN --max-time 60 "$api/agents/$id/events" "${auth[@]}" -H "Last-Event-ID: 0" > "$out/stream-replay-all.sse"

node "$here/sse.mjs" summary "$out/stream-replay-all.sse" | tee "$out/summary.json"
node "$here/sse.mjs" join "$out/stream-resumed.sse" "$out/stream-part1.sse" "$out/stream-part2.sse"
node "$here/sse.mjs" compare "$out/stream-replay-all.sse" "$out/stream-resumed.sse" 0
if [ "${RESTART_BACKEND:-}" != 1 ]; then
  node "$here/sse.mjs" compare "$out/stream-replay-all.sse" "$out/stream-full.sse" 0
fi
half=$(( $(jq .lastSeq "$out/summary.json") / 2 ))
curl -sN --max-time 60 "$api/agents/$id/events" "${auth[@]}" -H "Last-Event-ID: $half" > "$out/stream-replay.sse"
node "$here/sse.mjs" compare "$out/stream-replay-all.sse" "$out/stream-replay.sse" "$half"

curl -sf "$api/agents/$id" "${auth[@]}" > "$out/agent-final.json"
jq -c '{id, status, prUrl, runs: [.runs[] | {status, exitCode}]}' "$out/agent-final.json"

leaks=0
sqlite3 "$db" .dump > "$out/db-dump.sql"
sqlite3 "$db" "select data from events where agent_id = '$id' order by seq" > "$out/stored-events.jsonl"
files=("$out/db-dump.sql" "$out/stored-events.jsonl" "$out/stream-replay-all.sse" "$out/agent-final.json" "$out/credentials.json")
[ -n "$log" ] && files+=("$log")
for s in "$OPENCODE_API_KEY" "$GH_TOKEN" "$cat_token"; do
  for f in "${files[@]}"; do
    if grep -qF -- "$s" "$f"; then echo "LEAK in $f"; leaks=1; fi
  done
done
echo "checked ${#files[@]} files for 3 credential values: leaks=$leaks"
rm -f "$out/token.json"
[ "$leaks" = 0 ] && [ "$(jq -r .status "$out/agent-final.json")" = succeeded ] && [ "$(jq -r .prUrl "$out/agent-final.json")" != null ]
