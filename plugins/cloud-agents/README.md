# @alaborderie/plugin-cloud-agents

The frontend plugin of cloud agents, built on Backstage UI. It adds the page `/cloud-agents` with:

- the agents list: what needs you first, then what runs, then what finished, with search, a status filter, and `J`/`K`/`↵`/`N`/`/` keys;
- an agent's page: its live event timeline, the composer that answers its questions or sends a follow-up, Stop, and its pull request, usage, and workspace;
- the new agent form, which checks your credentials before Start and accepts `?repo=<owner>/<name>&issue=<number>&title=<title>`;
- the settings page, where each user sets their credentials and creates personal access tokens.

It also adds a Cloud agents widget for the home page (`@backstage/plugin-home`), also exported from `@alaborderie/plugin-cloud-agents/alpha`.

On the new frontend system, `app.packages: all` discovers the plugin. Otherwise add the default export to `createApp({ features })`. On the legacy frontend system, mount `<CloudAgentsPage />` at `/cloud-agents` and add `legacyCloudAgentsPlugin` to the app's plugins.

The [repository README](../../README.md) describes the backend plugin and the configuration.

## Start from a catalog entity

On the new frontend system, the plugin adds a **New agent** button in an info
card on the entity overview. It appears only when the entity has the
`github.com/project-slug` annotation. Both repository Components and deployed
workload Components use the same action. No app wiring is needed with
`app.packages: all`.

The button opens the new agent form with the repository and an editable context
prompt. The prompt includes the entity title and ref, kind, type, description,
links, Kubernetes namespace, ID, label selector and cluster when annotated, and
the current catalog page URL. It ends with an empty `Task:` section for you to
write the task. The action uses Backstage UI and inherits the app's BUI/Ember
styling. An info card keeps the action visible without replacing the catalog
header or using the legacy Material UI About-card icon renderer.

## Deep links

`/cloud-agents/new?repo=owner/name` prefills the repository. Add URL-encoded
`title` and `prompt` parameters to prefill those fields. For example:

```text
/cloud-agents/new?repo=alaborderie/keyroll&title=T&prompt=P
```

Invalid repository values are ignored. A valid `issue` number keeps the existing
issue banner, title, generated issue prompt, and dismissal behavior. When both
`issue` and `prompt` are supplied, the generated issue prompt takes precedence.
Opening a link never starts an agent automatically.

## Preview with Ember styling

Run `yarn install --immutable`, then `yarn start:frontend` from the repository
root. No backend is needed for these mock routes at `http://localhost:3000`:

- `/catalog/default/component/keyroll?mock` shows a repository with the action.
- `/catalog/default/component/keyroll-api?mock` shows a workload with host and Kubernetes context.
- `/catalog/default/component/without-repo?mock` shows an entity without the action.
- `/cloud-agents/new?mock&repo=alaborderie/keyroll&title=T&prompt=P` prefills all three fields.
- `/cloud-agents/new?mock&repo=alaborderie/keyroll&issue=42&title=T` preserves issue prefill.

Click **New agent** on either annotated entity and inspect the repository and
prompt. The dev app uses the existing Ember preview tokens. Mock mode persists
for the tab; `?mock=0` restores real API calls.
