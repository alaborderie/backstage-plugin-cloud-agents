import {
  createApiRef,
  type DiscoveryApi,
  type FetchApi,
} from '@backstage/frontend-plugin-api';
import type {
  Conversation,
  ConversationDetail,
  SummaryResponse,
  TurnEvent,
} from '@alaborderie/plugin-assistant-common';
import {
  readSse,
  type Agent,
  type AgentEventEnvelope,
} from '@alaborderie/plugin-cloud-agents-common';

/** A non-2xx answer of the assistant or cloud-agents API. */
export class AssistantApiError extends Error {
  constructor(readonly status: number, readonly body: unknown) {
    super(AssistantApiError.describe(status, body));
  }

  private static describe(status: number, body: unknown): string {
    if (body && typeof body === 'object' && 'error' in body) {
      const error = (body as { error: unknown }).error;
      if (typeof error === 'string') return error;
      if (error && typeof error === 'object' && 'message' in error) {
        return String((error as { message: unknown }).message);
      }
    }
    return `Request failed with status ${status}`;
  }
}

/** The calls the page makes: docs/ASSISTANT.md, and the agents it follows. */
export interface AssistantApi {
  listConversations(): Promise<Conversation[]>;
  createConversation(): Promise<Conversation>;
  getConversation(id: string): Promise<ConversationDetail>;
  /** Starts a turn and calls `onEvent` for each event until the stream closes. */
  sendMessage(
    id: string,
    text: string,
    onEvent: (event: TurnEvent) => void,
    signal: AbortSignal,
  ): Promise<void>;
  summarize(conversationId: string, agentId: string): Promise<SummaryResponse>;
  getAgent(agentId: string): Promise<Agent>;
  /** Streams a cloud agent's events after `after` until the server closes it. */
  followAgentEvents(
    agentId: string,
    after: number,
    onEnvelope: (envelope: AgentEventEnvelope) => void,
    signal: AbortSignal,
  ): Promise<void>;
}

export const assistantApiRef = createApiRef<AssistantApi>({
  id: 'plugin.assistant.api',
});

type Backend = 'assistant' | 'cloud-agents';

export class AssistantClient implements AssistantApi {
  constructor(
    private readonly options: {
      discoveryApi: DiscoveryApi;
      fetchApi: FetchApi;
    },
  ) {}

  private async fetch(
    backend: Backend,
    path: string,
    init?: RequestInit,
  ): Promise<Response> {
    const base = await this.options.discoveryApi.getBaseUrl(backend);
    const response = await this.options.fetchApi.fetch(`${base}${path}`, init);
    if (!response.ok) {
      const text = await response.text();
      let body: unknown = text;
      try {
        body = JSON.parse(text);
      } catch {
        // keep the text
      }
      throw new AssistantApiError(response.status, body);
    }
    return response;
  }

  private async json<T>(
    backend: Backend,
    path: string,
    method = 'GET',
    body?: unknown,
  ): Promise<T> {
    const response = await this.fetch(backend, path, {
      method,
      ...(body !== undefined && {
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      }),
    });
    return (await response.json()) as T;
  }

  async listConversations(): Promise<Conversation[]> {
    const { conversations } = await this.json<{
      conversations: Conversation[];
    }>('assistant', '/conversations');
    return conversations;
  }

  createConversation(): Promise<Conversation> {
    return this.json('assistant', '/conversations', 'POST', {});
  }

  getConversation(id: string): Promise<ConversationDetail> {
    return this.json('assistant', `/conversations/${encodeURIComponent(id)}`);
  }

  async sendMessage(
    id: string,
    text: string,
    onEvent: (event: TurnEvent) => void,
    signal: AbortSignal,
  ): Promise<void> {
    const response = await this.fetch(
      'assistant',
      `/conversations/${encodeURIComponent(id)}/messages`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'text/event-stream',
        },
        body: JSON.stringify({ text }),
        signal,
      },
    );
    if (!response.body) throw new Error('The turn stream has no body');
    await readSse(response.body, message =>
      onEvent(JSON.parse(message.data) as TurnEvent),
    );
  }

  summarize(conversationId: string, agentId: string): Promise<SummaryResponse> {
    return this.json(
      'assistant',
      `/conversations/${encodeURIComponent(
        conversationId,
      )}/agents/${encodeURIComponent(agentId)}/summary`,
      'POST',
      {},
    );
  }

  getAgent(agentId: string): Promise<Agent> {
    return this.json('cloud-agents', `/agents/${encodeURIComponent(agentId)}`);
  }

  async followAgentEvents(
    agentId: string,
    after: number,
    onEnvelope: (envelope: AgentEventEnvelope) => void,
    signal: AbortSignal,
  ): Promise<void> {
    const response = await this.fetch(
      'cloud-agents',
      `/agents/${encodeURIComponent(agentId)}/events?after=${after}`,
      { headers: { Accept: 'text/event-stream' }, signal },
    );
    if (!response.body) throw new Error('The event stream has no body');
    await readSse(response.body, message => {
      if (message.event === 'agent-event') {
        onEnvelope(JSON.parse(message.data) as AgentEventEnvelope);
      }
    });
  }
}
