import type { ToolCallRequest } from '@alaborderie/plugin-assistant-common';

/** One message of an OpenAI-compatible Chat Completions request. */
export type ChatMessage =
  | { role: 'system'; content: string }
  | { role: 'user'; content: string }
  | {
      role: 'assistant';
      content: string | null;
      tool_calls?: {
        id: string;
        type: 'function';
        function: { name: string; arguments: string };
      }[];
    }
  | { role: 'tool'; tool_call_id: string; content: string };

export interface ToolSpec {
  type: 'function';
  function: { name: string; description: string; parameters: object };
}

export interface Completion {
  text: string;
  toolCalls: ToolCallRequest[];
}

export interface ChatRequest {
  messages: ChatMessage[];
  tools?: ToolSpec[];
  /** OpenCode Go routes and caches by this id; one per conversation. */
  sessionId: string;
  signal?: AbortSignal;
  onText?: (text: string) => void;
}

/** The chat model in the turn loop: one streamed completion per call. */
export interface ChatModel {
  complete(request: ChatRequest): Promise<Completion>;
}

interface ChunkDelta {
  content?: string | null;
  tool_calls?: {
    index: number;
    id?: string;
    function?: { name?: string; arguments?: string };
  }[];
}

/**
 * An OpenAI-compatible Chat Completions endpoint, streamed. Reasoning is off,
 * since the chat answers first and hands hard questions to the reasoning tool.
 */
export class OpenAiCompatibleChatModel implements ChatModel {
  constructor(
    private readonly options: {
      baseUrl: string;
      apiKey: string;
      model: string;
    },
  ) {}

  async complete(request: ChatRequest): Promise<Completion> {
    const response = await fetch(`${this.options.baseUrl}/chat/completions`, {
      method: 'POST',
      signal: request.signal,
      headers: {
        Authorization: `Bearer ${this.options.apiKey}`,
        'Content-Type': 'application/json',
        'User-Agent': 'backstage-assistant/0.1',
        'x-opencode-session': request.sessionId,
      },
      body: JSON.stringify({
        model: this.options.model,
        stream: true,
        thinking: { type: 'disabled' },
        messages: request.messages,
        ...(request.tools?.length ? { tools: request.tools } : {}),
      }),
    });
    if (!response.ok || !response.body) {
      const body = (await response.text()).slice(0, 500);
      throw new Error(`The chat model answered ${response.status}: ${body}`);
    }

    let text = '';
    const calls: { id: string; name: string; arguments: string }[] = [];
    const onChunk = (data: string) => {
      const chunk = JSON.parse(data) as {
        choices?: { delta?: ChunkDelta }[];
      };
      const delta = chunk.choices?.[0]?.delta;
      if (!delta) return;
      if (delta.content) {
        text += delta.content;
        request.onText?.(delta.content);
      }
      for (const part of delta.tool_calls ?? []) {
        const call = (calls[part.index] ??= {
          id: '',
          name: '',
          arguments: '',
        });
        if (part.id) call.id = part.id;
        if (part.function?.name) call.name += part.function.name;
        if (part.function?.arguments) {
          call.arguments += part.function.arguments;
        }
      }
    };

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let newline = buffer.indexOf('\n');
      while (newline !== -1) {
        const line = buffer.slice(0, newline).trim();
        buffer = buffer.slice(newline + 1);
        if (line.startsWith('data:')) {
          const data = line.slice(5).trim();
          if (data && data !== '[DONE]') onChunk(data);
        }
        newline = buffer.indexOf('\n');
      }
    }
    return {
      text,
      toolCalls: calls
        .filter(call => call.name)
        .map((call, index) => ({
          id: call.id || `call_${index}`,
          name: call.name,
          arguments: call.arguments || '{}',
        })),
    };
  }
}
