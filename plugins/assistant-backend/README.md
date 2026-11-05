# @alaborderie/plugin-assistant-backend

The backend of the assistant chat. It stores each user's conversations, streams each turn from an OpenAI-compatible chat model, and runs the model's tools: the catalog, TechDocs, read-only GitHub, the `cloud-agents:*` actions as the user, and Claude Opus 5.5 with the user's own Anthropic API key. [docs/ASSISTANT.md](../../docs/ASSISTANT.md) has the API, the tools, and the configuration.

```ts
backend.add(import('@alaborderie/plugin-assistant-backend'));
```

It needs the catalog, search, and TechDocs backends, the cloud-agents backend with `backend.actions.pluginSources: [cloud-agents]`, and `ASSISTANT_OPENCODE_GO_API_KEY` or `assistant.chatModel.apiKey`.
