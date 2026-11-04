import {
  createApiRef,
  type DiscoveryApi,
  type FetchApi,
} from '@backstage/frontend-plugin-api';
import type {
  AccessToken,
  Agent,
  AgentEventEnvelope,
  AgentStatus,
  CreateAgentRequest,
  CreatedAccessToken,
  CredentialName,
  CredentialsSummary,
  PutCredentialRequest,
} from '@alaborderie/plugin-cloud-agents-common';
import { readSse } from './sse';

/** A non-2xx answer of the cloud-agents API, with its JSON body when it has one. */
export class CloudAgentsApiError extends Error {
  constructor(readonly status: number, readonly body: unknown) {
    super(CloudAgentsApiError.describe(status, body));
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

  /** The credential a `422 missing_credential` names, if this is one. */
  get missingCredential(): string | undefined {
    const body = this.body as {
      error?: unknown;
      credential?: string;
      harness?: string;
    };
    return this.status === 422 && body?.error === 'missing_credential'
      ? body.credential ?? body.harness
      : undefined;
  }
}

/** The calls the frontend makes to the API in docs/API.md. */
export interface CloudAgentsApi {
  listAgents(status?: AgentStatus): Promise<Agent[]>;
  getAgent(id: string): Promise<Agent>;
  createAgent(request: CreateAgentRequest): Promise<Agent>;
  reply(id: string, questionId: string, answer: string): Promise<void>;
  message(id: string, text: string): Promise<void>;
  stop(id: string): Promise<void>;
  /**
   * Streams the agent's events after `after` until the server closes the
   * stream, which it does once the agent is terminal.
   */
  streamEvents(
    id: string,
    after: number,
    onEvent: (envelope: AgentEventEnvelope) => void,
    signal: AbortSignal,
  ): Promise<void>;
  getCredentials(): Promise<CredentialsSummary>;
  putCredential(
    name: CredentialName,
    request: PutCredentialRequest,
  ): Promise<CredentialsSummary>;
  deleteCredential(name: CredentialName): Promise<CredentialsSummary>;
  githubConnectUrl(): Promise<string>;
  listTokens(): Promise<AccessToken[]>;
  createToken(name: string): Promise<CreatedAccessToken>;
  deleteToken(id: string): Promise<void>;
}

export const cloudAgentsApiRef = createApiRef<CloudAgentsApi>({
  id: 'plugin.cloud-agents.api',
});

export class CloudAgentsClient implements CloudAgentsApi {
  constructor(
    private readonly options: {
      discoveryApi: DiscoveryApi;
      fetchApi: FetchApi;
    },
  ) {}

  private async fetch(path: string, init?: RequestInit): Promise<Response> {
    const base = await this.options.discoveryApi.getBaseUrl('cloud-agents');
    const response = await this.options.fetchApi.fetch(`${base}${path}`, init);
    if (!response.ok) {
      const text = await response.text();
      let body: unknown = text;
      try {
        body = JSON.parse(text);
      } catch {
        // keep the text
      }
      throw new CloudAgentsApiError(response.status, body);
    }
    return response;
  }

  private async json<T>(
    path: string,
    method = 'GET',
    body?: unknown,
  ): Promise<T> {
    const response = await this.fetch(path, {
      method,
      ...(body === undefined
        ? {}
        : {
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
          }),
    });
    const text = await response.text();
    return (text ? JSON.parse(text) : undefined) as T;
  }

  listAgents(status?: AgentStatus): Promise<Agent[]> {
    return this.json(status ? `/agents?status=${status}` : '/agents');
  }

  getAgent(id: string): Promise<Agent> {
    return this.json(`/agents/${encodeURIComponent(id)}`);
  }

  createAgent(request: CreateAgentRequest): Promise<Agent> {
    return this.json('/agents', 'POST', request);
  }

  async reply(id: string, questionId: string, answer: string): Promise<void> {
    await this.json(`/agents/${encodeURIComponent(id)}/reply`, 'POST', {
      questionId,
      answer,
    });
  }

  async message(id: string, text: string): Promise<void> {
    await this.json(`/agents/${encodeURIComponent(id)}/messages`, 'POST', {
      text,
    });
  }

  async stop(id: string): Promise<void> {
    await this.json(`/agents/${encodeURIComponent(id)}/stop`, 'POST', {});
  }

  async streamEvents(
    id: string,
    after: number,
    onEvent: (envelope: AgentEventEnvelope) => void,
    signal: AbortSignal,
  ): Promise<void> {
    const response = await this.fetch(
      `/agents/${encodeURIComponent(id)}/events?after=${after}`,
      { headers: { Accept: 'text/event-stream' }, signal },
    );
    if (!response.body) throw new Error('The event stream has no body');
    await readSse(response.body, message => {
      if (message.event === 'agent-event') {
        onEvent(JSON.parse(message.data) as AgentEventEnvelope);
      }
    });
  }

  getCredentials(): Promise<CredentialsSummary> {
    return this.json('/me/credentials');
  }

  putCredential(
    name: CredentialName,
    request: PutCredentialRequest,
  ): Promise<CredentialsSummary> {
    return this.json(`/me/credentials/${name}`, 'PUT', request);
  }

  deleteCredential(name: CredentialName): Promise<CredentialsSummary> {
    return this.json(`/me/credentials/${name}`, 'DELETE');
  }

  async githubConnectUrl(): Promise<string> {
    const response = await this.fetch('/me/github/connect', {
      headers: { Accept: 'application/json' },
    });
    return ((await response.json()) as { url: string }).url;
  }

  listTokens(): Promise<AccessToken[]> {
    return this.json('/me/tokens');
  }

  createToken(name: string): Promise<CreatedAccessToken> {
    return this.json('/me/tokens', 'POST', { name });
  }

  async deleteToken(id: string): Promise<void> {
    await this.fetch(`/me/tokens/${encodeURIComponent(id)}`, {
      method: 'DELETE',
    });
  }
}
