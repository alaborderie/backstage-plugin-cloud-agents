import type {
  BackstageCredentials,
  LoggerService,
} from '@backstage/backend-plugin-api';
import { ConflictError, NotFoundError } from '@backstage/errors';
import type {
  AgentSummaryItem,
  AssistantItem,
  ConversationItem,
  ToolItem,
  TurnEvent,
} from '@alaborderie/plugin-assistant-common';
import {
  isTerminalAgentStatus,
  type Agent,
} from '@alaborderie/plugin-cloud-agents-common';
import type { ChatMessage, ChatModel } from './chatModel';
import type { PromptBuilder } from './prompt';
import type { Store } from './store';
import {
  isToolName,
  toolDef,
  TOOL_SPECS,
  type ToolContext,
  type ToolDeps,
} from './tools';

/** Model calls per turn; the last one gets no tools, so it must answer. */
const MAX_STEPS = 8;
/** What the model reads of one tool output, in characters. */
const MODEL_OUTPUT_CHARS = 16_000;
/** What an item stores of one tool output. */
const STORED_OUTPUT_CHARS = 20_000;

const SUMMARY_PROMPT = `A cloud coding agent that the user launched from this chat has finished. Tell the user what it did in 2 to 5 sentences of Markdown: the outcome, the pull request link if there is one, and what failed and why if it failed. For a hub, say what its children did. Do not invent details.`;

function clip(value: unknown, max: number): string {
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  return text.length > max ? `${text.slice(0, max)}…[cut]` : text;
}

function storedOutput(value: unknown): unknown {
  const text = JSON.stringify(value) ?? 'null';
  return text.length > STORED_OUTPUT_CHARS
    ? { truncated: true, text: text.slice(0, STORED_OUTPUT_CHARS) }
    : value;
}

function assistantMessage(item: AssistantItem): ChatMessage {
  return {
    role: 'assistant',
    content: item.text || null,
    ...(item.toolCalls.length
      ? {
          tool_calls: item.toolCalls.map(call => ({
            id: call.id,
            type: 'function' as const,
            function: { name: call.name, arguments: call.arguments },
          })),
        }
      : {}),
  };
}

/**
 * The chat history as the model reads it. A tool call without a stored result
 * (a turn cut short) gets one, since the API refuses a dangling call.
 */
export function historyOf(items: ConversationItem[]): ChatMessage[] {
  const results = new Map(
    items.flatMap(item =>
      item.type === 'tool' ? [[item.toolCallId, item] as const] : [],
    ),
  );
  const messages: ChatMessage[] = [];
  for (const item of items) {
    switch (item.type) {
      case 'user':
        messages.push({ role: 'user', content: item.text });
        break;
      case 'assistant':
        if (!item.text && !item.toolCalls.length) break;
        messages.push(assistantMessage(item));
        for (const call of item.toolCalls) {
          const result = results.get(call.id);
          messages.push({
            role: 'tool',
            tool_call_id: call.id,
            content:
              result && result.status !== 'running'
                ? clip(
                    result.error ? { error: result.error } : result.output,
                    MODEL_OUTPUT_CHARS,
                  )
                : '{"error":"interrupted"}',
          });
        }
        break;
      case 'agent_summary':
        messages.push({
          role: 'assistant',
          content: `Agent ${item.agentId} finished (${item.status}). ${item.text}`,
        });
        break;
      default:
        break;
    }
  }
  return messages;
}

export interface Caller {
  credentials: BackstageCredentials;
  userEntityRef: string;
}

/** Conversations, their turns, and the summaries of the agents they launch. */
export class Assistant {
  private readonly running = new Set<string>();
  private readonly summarizing = new Map<
    string,
    Promise<AgentSummaryItem | null>
  >();

  constructor(
    private readonly store: Store,
    private readonly chat: ChatModel | undefined,
    private readonly prompts: PromptBuilder,
    private readonly tools: ToolDeps,
    private readonly logger: LoggerService,
  ) {}

  get ready(): boolean {
    return this.chat !== undefined;
  }

  /**
   * One turn: stores the user's message, then calls the model and its tools
   * until it answers without a tool call. `emit` gets every item change and
   * text delta as it happens.
   */
  async runTurn(
    caller: Caller,
    conversationId: string,
    text: string,
    emit: (event: TurnEvent) => void,
    signal: AbortSignal,
  ): Promise<void> {
    const chat = this.chat;
    if (!chat) throw new Error('The chat model has no API key');
    const conversation = await this.store.getConversation(
      caller.userEntityRef,
      conversationId,
    );
    if (this.running.has(conversationId)) {
      throw new ConflictError('This conversation already has a turn running');
    }
    this.running.add(conversationId);
    try {
      const system = this.prompts.systemPrompt(
        caller.userEntityRef,
        caller.credentials,
      );
      const earlier = await this.store.listItems(conversationId);
      const user = await this.store.appendItem(conversationId, {
        type: 'user',
        text,
      });
      emit({ type: 'item', item: user });
      if (!earlier.some(item => item.type === 'user')) {
        await this.store.setTitle(
          conversationId,
          text.replace(/\s+/g, ' ').trim().slice(0, 80),
        );
      }
      const messages: ChatMessage[] = [
        { role: 'system', content: await system },
        ...historyOf([...earlier, user]),
      ];

      for (let step = 1; step <= MAX_STEPS; step++) {
        const reply = await this.complete(
          chat,
          conversation.id,
          messages,
          step < MAX_STEPS,
          emit,
          signal,
        );
        if (!reply.toolCalls.length) break;
        messages.push(assistantMessage(reply));
        const results = await Promise.all(
          reply.toolCalls.map(call =>
            this.runTool(caller, conversationId, call, emit, signal),
          ),
        );
        for (const result of results) {
          messages.push({
            role: 'tool',
            tool_call_id: result.toolCallId,
            content: clip(
              result.error ? { error: result.error } : result.output,
              MODEL_OUTPUT_CHARS,
            ),
          });
        }
      }
      emit({ type: 'done' });
    } finally {
      this.running.delete(conversationId);
    }
  }

  private async complete(
    chat: ChatModel,
    conversationId: string,
    messages: ChatMessage[],
    withTools: boolean,
    emit: (event: TurnEvent) => void,
    signal: AbortSignal,
  ): Promise<AssistantItem> {
    const item = await this.store.appendItem(conversationId, {
      type: 'assistant',
      text: '',
      toolCalls: [],
      status: 'streaming',
      error: null,
    });
    emit({ type: 'item', item });
    try {
      const completion = await chat.complete({
        messages,
        ...(withTools ? { tools: TOOL_SPECS } : {}),
        sessionId: conversationId,
        signal,
        onText: delta => {
          item.text += delta;
          emit({ type: 'delta', itemId: item.id, text: delta });
        },
      });
      const done: AssistantItem = {
        ...item,
        text: completion.text,
        toolCalls: completion.toolCalls,
        status: 'done',
      };
      await this.store.updateItem(done);
      emit({ type: 'item', item: done });
      return done;
    } catch (error) {
      const failed: AssistantItem = {
        ...item,
        status: 'error',
        error: signal.aborted ? 'Stopped' : (error as Error).message,
      };
      await this.store.updateItem(failed);
      emit({ type: 'item', item: failed });
      throw error;
    }
  }

  private async runTool(
    caller: Caller,
    conversationId: string,
    call: { id: string; name: string; arguments: string },
    emit: (event: TurnEvent) => void,
    signal: AbortSignal,
  ): Promise<ToolItem> {
    let input: unknown = call.arguments;
    try {
      input = JSON.parse(call.arguments || '{}');
    } catch {
      // The model wrote invalid JSON; the error below tells it so.
    }
    const item = await this.store.appendItem(conversationId, {
      type: 'tool',
      toolCallId: call.id,
      name: call.name,
      input,
      output: null,
      status: 'running',
      error: null,
      durationMs: null,
    });
    emit({ type: 'item', item });
    const started = Date.now();
    const finish = async (patch: Partial<ToolItem>) => {
      const done: ToolItem = {
        ...item,
        status: 'done',
        durationMs: Date.now() - started,
        ...patch,
      };
      await this.store.updateItem(done);
      emit({ type: 'item', item: done });
      return done;
    };

    if (!isToolName(call.name)) {
      return finish({ status: 'error', error: `No tool ${call.name}` });
    }
    const def = toolDef(call.name);
    const parsed = def.input.safeParse(input);
    if (!parsed.success) {
      return finish({
        status: 'error',
        error: `Invalid input: ${parsed.error.message}`,
      });
    }
    const ctx: ToolContext = { ...caller, signal };
    let output: unknown;
    try {
      output = await def.run(parsed.data, ctx, this.tools);
    } catch (error) {
      this.logger.warn(`Tool ${call.name} failed: ${(error as Error).message}`);
      return finish({ status: 'error', error: (error as Error).message });
    }
    const done = await finish({ output: storedOutput(output) });
    if (def.launches) {
      const card = await this.store.appendItem(
        conversationId,
        def.launches(output),
      );
      emit({ type: 'item', item: card });
    }
    return { ...done, output };
  }

  /**
   * The summary of an agent this conversation launched, written once the
   * agent is terminal. It runs on the caller's request with the caller's
   * credentials, so no background job needs to hold them.
   */
  async summarize(
    caller: Caller,
    conversationId: string,
    agentId: string,
  ): Promise<AgentSummaryItem | null> {
    await this.store.getConversation(caller.userEntityRef, conversationId);
    const existing = await this.store.findSummary(conversationId, agentId);
    if (existing) return existing;
    const items = await this.store.listItems(conversationId);
    if (!items.some(i => i.type === 'agent' && i.agentId === agentId)) {
      throw new NotFoundError(`This conversation launched no agent ${agentId}`);
    }
    const key = `${conversationId}/${agentId}`;
    const pending =
      this.summarizing.get(key) ??
      this.writeSummary(caller, conversationId, agentId).finally(() =>
        this.summarizing.delete(key),
      );
    this.summarizing.set(key, pending);
    return pending;
  }

  private async writeSummary(
    caller: Caller,
    conversationId: string,
    agentId: string,
  ): Promise<AgentSummaryItem | null> {
    const chat = this.chat;
    if (!chat) throw new Error('The chat model has no API key');
    const { output } = await this.tools.actions.invoke({
      id: 'cloud-agents:get-agent',
      input: { id: agentId },
      credentials: caller.credentials,
    });
    const { agent, lastMessage } = output as unknown as {
      agent: Agent;
      lastMessage: string | null;
    };
    if (!isTerminalAgentStatus(agent.status)) return null;
    const { text } = await chat.complete({
      sessionId: conversationId,
      messages: [
        { role: 'system', content: SUMMARY_PROMPT },
        {
          role: 'user',
          content: JSON.stringify({
            kind: agent.kind,
            title: agent.title,
            repo: agent.repo,
            branch: agent.branch,
            status: agent.status,
            prUrl: agent.prUrl,
            children: agent.children,
            lastMessage,
          }),
        },
      ],
    });
    try {
      return await this.store.appendItem(conversationId, {
        type: 'agent_summary',
        agentId,
        status: agent.status,
        prUrl: agent.prUrl,
        text,
      });
    } catch (error) {
      const raced = await this.store.findSummary(conversationId, agentId);
      if (raced) return raced;
      throw error;
    }
  }
}
