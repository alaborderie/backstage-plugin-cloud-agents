# Assistant API

The `assistant` plugins add a chat to Backstage. The backend plugin
`assistant-backend` serves it at `/api/assistant`. The types are in
`@alaborderie/plugin-assistant-common`.

A turn runs the chat model, a fast model without reasoning (DeepSeek V4.1 Flash
through OpenCode Go by default), with a tool loop. The model answers from a
catalog index in its system prompt, and calls tools for the rest:

| Tool                  | What it does                                                                                                 |
| --------------------- | ------------------------------------------------------------------------------------------------------------ |
| `search_catalog`      | Full-text search of the catalog, as the user.                                                                |
| `get_entity`          | One entity by ref, with its relations.                                                                       |
| `search_techdocs`     | The search backend, documents of type `techdocs`, as the user.                                               |
| `read_techdocs_page`  | The text of one TechDocs page from its search location.                                                      |
| `github_get`          | A `GET` of the GitHub REST API with the app's GitHub integration. Read-only.                                 |
| `list_agents`         | `cloud-agents:list-agents` as the user.                                                                      |
| `get_agent`           | `cloud-agents:get-agent` as the user.                                                                        |
| `create_agent`        | `cloud-agents:create-agent` as the user, kind `task` or `hub`. Adds an `agent` item to the conversation.     |
| `reply_to_agent`      | `cloud-agents:reply-to-agent` as the user.                                                                   |
| `send_agent_message`  | `cloud-agents:send-agent-message` as the user.                                                               |
| `stop_agent`          | `cloud-agents:stop-agent` as the user.                                                                       |
| `ask_reasoning_model` | One call to Claude Opus 5.5 with the user's Anthropic API key, stored in Cloud agents settings. Synchronous. |

Every route acts for the signed-in Backstage user. A user sees only their own
conversations.

## Routes

### `GET /conversations`

`{"conversations": [Conversation]}`, most recently updated first.

```json
{
  "id": "cv_...",
  "title": "Which services run on k3s?",
  "createdAt": "ISO",
  "updatedAt": "ISO"
}
```

### `POST /conversations`

Creates an empty conversation. Body `{}`. Answers `201` with the `Conversation`.
The first message sets its title.

### `GET /conversations/:id`

`{"conversation": Conversation, "items": [ConversationItem]}`, items in `seq`
order. `404` for another user's conversation.

### `POST /conversations/:id/messages`

Body `{"text": "..."}`. Starts a turn and answers with a `text/event-stream`.
Each SSE message has `event: <type>` and `data: <JSON of the event>`:

| Event   | Data                                                                                                             |
| ------- | ---------------------------------------------------------------------------------------------------------------- |
| `item`  | `{"type": "item", "item": ConversationItem}`: an item was created or changed. Replace any item of the same `id`. |
| `delta` | `{"type": "delta", "itemId": "...", "text": "..."}`: append to the streaming assistant item.                     |
| `done`  | `{"type": "done"}`. The stream closes.                                                                           |
| `error` | `{"type": "error", "message": "..."}`. The stream closes.                                                        |

The first event is the `user` item. A turn has up to 8 model calls. `409` when
the conversation already has a turn running. If the client disconnects, the
turn stops and keeps what it stored.

### `POST /conversations/:id/agents/:agentId/summary`

Writes the summary of an agent that this conversation launched, once the agent
is `succeeded`, `failed`, or `stopped`. It reads the agent and its last message
with `cloud-agents:get-agent` as the caller, so it runs when the user has the
conversation open, not in the background. Calling it again returns the same
item. Answers `{"item": AgentSummaryItem}`, or `{"item": null}` while the agent
is not terminal. `404` when the conversation has no `agent` item with that id.

## Items

Every item has `id`, `conversationId`, `seq` (from 1), `createdAt`, and `type`:

| `type`          | Fields                                                                                                |
| --------------- | ----------------------------------------------------------------------------------------------------- |
| `user`          | `text`                                                                                                |
| `assistant`     | `text`, `toolCalls` (`[{id, name, arguments}]`), `status` (`streaming`, `done`, `error`), `error`     |
| `tool`          | `toolCallId`, `name`, `input`, `output`, `status` (`running`, `done`, `error`), `error`, `durationMs` |
| `agent`         | `agentId`, `agentKind` (`task` or `hub`), `title`, `repo`                                             |
| `agent_summary` | `agentId`, `status`, `prUrl`, `text`                                                                  |

The page follows an `agent` item with `GET /api/cloud-agents/agents/:id` and
`GET /api/cloud-agents/agents/:id/events`. When the agent is terminal and the
conversation has no `agent_summary` for it, the page asks for the summary.

## Anthropic API key

The reasoning tool uses the caller's own key, the `anthropic` credential of the
cloud-agents plugin (`PUT /api/cloud-agents/me/credentials/anthropic`). The
assistant backend reads it from `POST /api/cloud-agents/service/anthropic-key`,
which accepts only the `assistant` plugin's service token, so the key never
reaches a browser. Without a key, the tool answers that the user should add one
in Cloud agents settings.

## Configuration

| app-config key                   | Environment variable            | Default                                      |
| -------------------------------- | ------------------------------- | -------------------------------------------- |
| `assistant.chatModel.apiKey`     | `ASSISTANT_OPENCODE_GO_API_KEY` | required for chat                            |
| `assistant.chatModel.baseUrl`    |                                 | `https://opencode.ai/inference/go/openai/v1` |
| `assistant.chatModel.model`      |                                 | `deepseek-v4.1-flash`                        |
| `assistant.reasoningModel.model` |                                 | `claude-opus-5-5`                            |

The chat model's endpoint is any OpenAI-compatible Chat Completions API. Without
a key, the plugin starts and every message fails with `503`.
