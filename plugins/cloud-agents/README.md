# @alaborderie/plugin-cloud-agents

The frontend plugin of cloud agents, built on Backstage UI. It adds the page `/cloud-agents` with:

- the agents list: what needs you first, then what runs, then what finished, with search, a status filter, and `J`/`K`/`↵`/`N`/`/` keys;
- an agent's page: its live event timeline, the composer that answers its questions or sends a follow-up, Stop, and its pull request, usage, and workspace;
- the new agent form, which checks your credentials before Start and accepts `?repo=<owner>/<name>&issue=<number>&title=<title>`;
- the settings page, where each user sets their credentials and creates personal access tokens.

It also adds a Cloud agents widget for the home page (`@backstage/plugin-home`), also exported from `@alaborderie/plugin-cloud-agents/alpha`.

On the new frontend system, `app.packages: all` discovers the plugin. Otherwise add the default export to `createApp({ features })`. On the legacy frontend system, mount `<CloudAgentsPage />` at `/cloud-agents` and add `legacyCloudAgentsPlugin` to the app's plugins.

The [repository README](../../README.md) describes the backend plugin and the configuration.
