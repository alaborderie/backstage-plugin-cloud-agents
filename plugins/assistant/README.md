# @alaborderie/plugin-assistant

The frontend plugin of the assistant, built on Backstage UI. It adds the page
`/assistant`: a streaming chat that answers from your catalog, TechDocs,
GitHub, and cloud agents, and asks Claude Opus 5.5 when a question needs
reasoning.

- The left column lists your conversations. `/assistant/<id>` opens one, so a
  reload reopens the same conversation.
- Each answer streams in as it is written. Tool calls show as one-line chips;
  click one to see its input and output.
- When the assistant starts a cloud agent or hub, the conversation shows its
  card: status, what it is doing now, its open questions, its children, and its
  pull request. When the agent finishes, the conversation gets a summary of
  what it did, even if you open the conversation long after.

## Install

On the new frontend system, `app.packages: all` discovers the plugin and adds
its nav item. Otherwise add the default export to `createApp({ features })`:

```ts
import assistantPlugin from '@alaborderie/plugin-assistant';

const app = createApp({ features: [assistantPlugin] });
```

The page needs two backend plugins:

- `@alaborderie/plugin-assistant-backend`, which serves `/api/assistant`.
  [docs/ASSISTANT.md](../../docs/ASSISTANT.md) describes its API and
  configuration.
- `@alaborderie/plugin-cloud-agents-backend`. The assistant lists, starts, and
  follows agents through it, and the page reads each agent card from
  `/api/cloud-agents`. Install the `@alaborderie/plugin-cloud-agents` frontend
  too: agent cards link to its pages, and its Settings tab holds the Anthropic
  API key the reasoning tool uses.
