# Credentials and access tokens

## Sub-features

- Settings page cards for Claude Code, Codex (API key or `auth.json`), OpenCode Go, and GitHub: set, replace, clear. The page shows only whether each is set.
- `PUT`/`DELETE /me/credentials/:name`, `GET /me/credentials`.
- GitHub App connection (`/me/github/connect` and its callback) when `cloudAgents.github.clientId` and `clientSecret` are set; token paste otherwise.
- Personal access tokens: create (shown once), list, delete; `Authorization: Bearer cat_…` on every route.
- Values sealed with AES-256-GCM in the `credentials` table; never in responses, events, or logs.

## How to get to it (user POV)

**Cloud agents > Settings** (`/cloud-agents/settings`).

## Driving it with curl and Playwright

`scripts/ui.mjs` drives every card and the token list. `scripts/e2e.sh` sets credentials and creates the `cat_` token through the API, then greps `db-dump.sql`, `stored-events.jsonl`, the streams, and the backend log for the values.

## Gotchas

- The GitHub App flow needs a real App whose callback URLs include `<backend>/api/cloud-agents/me/github/callback`; the dev setup has none, so the UI shows only the token field. The backend integration test covers the App flow and the refresh at run start against a fake GitHub.
- A GitHub token is checked against `GET /user` when saved, so a dummy value fails with 400.
