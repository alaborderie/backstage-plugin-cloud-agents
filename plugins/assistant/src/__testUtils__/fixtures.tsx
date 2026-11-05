import type { ReactElement } from 'react';
import { renderInTestApp } from '@backstage/frontend-test-utils';
import type {
  AgentItem,
  AgentSummaryItem,
  AssistantItem,
  UserItem,
} from '@alaborderie/plugin-assistant-common';
import type { Agent } from '@alaborderie/plugin-cloud-agents-common';
import { assistantApiRef, type AssistantApi } from '../api';

export const NOW = '2026-11-05T10:00:00.000Z';

const base = (id: string, seq: number) => ({
  id,
  seq,
  conversationId: 'cv_1',
  createdAt: NOW,
});

export const userItem = (seq: number, text: string): UserItem => ({
  ...base(`it_${seq}`, seq),
  type: 'user',
  text,
});

export const assistantItem = (
  seq: number,
  text: string,
  status: AssistantItem['status'] = 'streaming',
): AssistantItem => ({
  ...base(`it_${seq}`, seq),
  type: 'assistant',
  text,
  toolCalls: [],
  status,
  error: null,
});

export const agentItem: AgentItem = {
  ...base('it_5', 5),
  type: 'agent',
  agentId: 'ag_000000000001',
  agentKind: 'task',
  title: 'Add a CONTRIBUTING.md',
  repo: 'alaborderie/cloud-agent-runner-sandbox',
};

export const summaryItem: AgentSummaryItem = {
  ...base('it_6', 6),
  type: 'agent_summary',
  agentId: agentItem.agentId,
  status: 'succeeded',
  prUrl: 'https://github.com/alaborderie/cloud-agent-runner-sandbox/pull/12',
  text: 'The agent added CONTRIBUTING.md and opened #12.',
};

export function agent(overrides: Partial<Agent> = {}): Agent {
  return {
    id: agentItem.agentId,
    kind: 'task',
    title: agentItem.title,
    repo: agentItem.repo,
    base: 'main',
    branch: 'cloud-agent/contributing',
    harness: 'opencode',
    model: 'opencode-go/deepseek-v4.1-flash',
    effort: 'high',
    status: 'succeeded',
    createdAt: NOW,
    updatedAt: NOW,
    runs: [],
    openQuestions: [],
    prUrl: summaryItem.prUrl,
    parent: null,
    parentId: null,
    children: [],
    activity: null,
    ...overrides,
  };
}

export function mockApi(
  overrides: Partial<AssistantApi> = {},
): jest.Mocked<AssistantApi> {
  return {
    listConversations: jest.fn(async () => []),
    createConversation: jest.fn(async () => ({
      id: 'cv_1',
      title: '',
      createdAt: NOW,
      updatedAt: NOW,
    })),
    getConversation: jest.fn(async () => {
      throw new Error('not found');
    }),
    sendMessage: jest.fn(async () => {}),
    summarize: jest.fn(async () => ({ item: summaryItem })),
    getAgent: jest.fn(async () => agent()),
    followAgentEvents: jest.fn(async () => {}),
    ...overrides,
  } as jest.Mocked<AssistantApi>;
}

/** Renders `element` in a test app with the mocked API, at `path`. */
export function render(
  element: ReactElement,
  api: AssistantApi,
  path = '/assistant',
) {
  return renderInTestApp(element, {
    apis: [[assistantApiRef, api]],
    mountPath: '/assistant/*',
    initialRouteEntries: [path],
  });
}

/** A promise and the function that resolves it. */
export function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(r => {
    resolve = r;
  });
  return { promise, resolve };
}
