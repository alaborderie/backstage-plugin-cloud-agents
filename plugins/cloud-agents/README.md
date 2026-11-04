# @alaborderie/plugin-cloud-agents

The frontend plugin of cloud agents. It adds the page `/cloud-agents` with the agents list, an agent's live event timeline, its open questions with an answer box, a stop button, the new agent form, and the settings page where each user sets their credentials and creates personal access tokens.

On the new frontend system, `app.packages: all` discovers the plugin. Otherwise add the default export to `createApp({ features })`. On the legacy frontend system, mount `<CloudAgentsPage />` at `/cloud-agents` and add `legacyCloudAgentsPlugin` to the app's plugins.

The [repository README](../../README.md) describes the backend plugin and the configuration.
