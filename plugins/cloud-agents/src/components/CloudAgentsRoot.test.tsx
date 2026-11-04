import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderInTestApp } from '@backstage/frontend-test-utils';
import type {
  Agent,
  AgentEventEnvelope,
  CredentialsSummary,
} from '@alaborderie/plugin-cloud-agents-common';
import {
  CloudAgentsApiError,
  cloudAgentsApiRef,
  type CloudAgentsApi,
} from '../api';
import { CloudAgentsRoot } from './Root';

const agent: Agent = {
  id: 'ag_000000000001',
  title: 'Add hello.txt',
  repo: 'acme/app',
  base: 'main',
  branch: 'cloud-agent/000000000001',
  harness: 'opencode',
  model: 'opencode-go/deepseek-v4.1-flash',
  effort: 'high',
  status: 'succeeded',
  createdAt: '2026-11-04T10:00:00Z',
  updatedAt: '2026-11-04T10:05:00Z',
  runs: [
    {
      id: 'run-1',
      status: 'succeeded',
      startedAt: '2026-11-04T10:00:00Z',
      finishedAt: '2026-11-04T10:05:00Z',
      exitCode: 0,
    },
  ],
  openQuestions: [],
  prUrl: 'https://github.com/acme/app/pull/7',
  parent: null,
};

const waiting: Agent = {
  ...agent,
  id: 'ag_000000000002',
  title: 'Pick a greeting',
  status: 'needs_input',
  prUrl: null,
  runs: [
    {
      id: 'run-2',
      status: 'needs_input',
      startedAt: '2026-11-04T11:00:00Z',
      finishedAt: '2026-11-04T11:01:00Z',
      exitCode: 3,
    },
  ],
  openQuestions: [
    {
      questionId: 'ask-1',
      runId: 'run-2',
      question: 'Which greeting?',
      options: ['hello', 'bonjour'],
    },
  ],
};

const unset: CredentialsSummary = {
  claude: { set: false, updatedAt: null },
  codex: { set: false, kind: null, updatedAt: null },
  opencode: { set: false, updatedAt: null },
  github: {
    connected: false,
    login: null,
    method: null,
    updatedAt: null,
    connectAvailable: false,
  },
};

function envelope(
  seq: number,
  event: Record<string, unknown>,
): AgentEventEnvelope {
  return {
    seq,
    runId: 'run-2',
    event: {
      v: 1,
      seq,
      ts: '2026-11-04T11:00:00Z',
      run_id: 'run-2',
      ...event,
    } as AgentEventEnvelope['event'],
  };
}

function mockApi(
  overrides: Partial<CloudAgentsApi> = {},
): jest.Mocked<CloudAgentsApi> {
  return {
    listAgents: jest.fn(async () => [waiting, agent]),
    getAgent: jest.fn(async (id: string) =>
      id === waiting.id ? waiting : agent,
    ),
    createAgent: jest.fn(async () => agent),
    reply: jest.fn(async () => {}),
    message: jest.fn(async () => {}),
    stop: jest.fn(async () => {}),
    streamEvents: jest.fn(async () => {}),
    getCredentials: jest.fn(async () => unset),
    putCredential: jest.fn(async () => unset),
    deleteCredential: jest.fn(async () => unset),
    githubConnectUrl: jest.fn(
      async () => 'https://github.com/login/oauth/authorize?x',
    ),
    listTokens: jest.fn(async () => []),
    createToken: jest.fn(async () => ({
      id: 'tok_1',
      token: 'cat_shown_once',
    })),
    deleteToken: jest.fn(async () => {}),
    ...overrides,
  } as jest.Mocked<CloudAgentsApi>;
}

function render(api: CloudAgentsApi, path: string) {
  return renderInTestApp(<CloudAgentsRoot />, {
    apis: [[cloudAgentsApiRef, api]],
    mountPath: '/cloud-agents/*',
    initialRouteEntries: [path],
  });
}

describe('agents list', () => {
  it('lists the user’s agents with status and pull request', async () => {
    const api = mockApi();
    await render(api, '/cloud-agents');
    expect(await screen.findByText('Add hello.txt')).toBeInTheDocument();
    expect(screen.getByText('Pick a greeting')).toBeInTheDocument();
    expect(screen.getByText('needs input')).toBeInTheDocument();
    expect(screen.getByText('acme/app/pull/7').closest('a')).toHaveAttribute(
      'href',
      'https://github.com/acme/app/pull/7',
    );
    expect(screen.getByText('Add hello.txt').closest('a')).toHaveAttribute(
      'href',
      '/cloud-agents/agents/ag_000000000001',
    );
  });
});

describe('new agent form', () => {
  it('starts an agent on the first tier and opens it', async () => {
    const api = mockApi();
    await render(api, '/cloud-agents/new');
    await userEvent.type(
      await screen.findByLabelText(/Repository/),
      'acme/app',
    );
    await userEvent.type(screen.getByLabelText(/Prompt/), 'Add hello.txt');
    await userEvent.click(screen.getByRole('button', { name: 'Start agent' }));
    await waitFor(() =>
      expect(api.createAgent).toHaveBeenCalledWith({
        repo: 'acme/app',
        base: 'main',
        prompt: 'Add hello.txt',
        tier: 'flash',
      }),
    );
    expect(
      await screen.findByText('cloud-agent/000000000001', { exact: false }),
    ).toBeInTheDocument();
  });

  it('sends harness, model, and effort in custom mode', async () => {
    const api = mockApi();
    await render(api, '/cloud-agents/new');
    await userEvent.type(
      await screen.findByLabelText(/Repository/),
      'acme/app',
    );
    await userEvent.type(screen.getByLabelText(/Prompt/), 'p');
    await userEvent.click(screen.getByLabelText('Harness and model'));
    await userEvent.type(
      screen.getByRole('textbox', { name: /^Model/ }),
      'opencode-go/x',
    );
    await userEvent.click(screen.getByRole('button', { name: 'Start agent' }));
    await waitFor(() =>
      expect(api.createAgent).toHaveBeenCalledWith({
        repo: 'acme/app',
        base: 'main',
        prompt: 'p',
        harness: 'opencode',
        model: 'opencode-go/x',
        effort: 'high',
      }),
    );
  });

  it('points to settings when the credential is missing', async () => {
    const api = mockApi({
      createAgent: jest.fn(async () => {
        throw new CloudAgentsApiError(422, {
          error: 'missing_credential',
          harness: 'opencode',
          credential: 'opencode',
        });
      }),
    });
    await render(api, '/cloud-agents/new');
    await userEvent.type(
      await screen.findByLabelText(/Repository/),
      'acme/app',
    );
    await userEvent.type(screen.getByLabelText(/Prompt/), 'p');
    await userEvent.click(screen.getByRole('button', { name: 'Start agent' }));
    expect(
      await screen.findByText(/Set your opencode credential/),
    ).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'settings' })).toHaveAttribute(
      'href',
      '/cloud-agents/settings',
    );
  });
});

describe('agent detail', () => {
  it('shows the live timeline, answers an open question, and stops', async () => {
    const api = mockApi({
      streamEvents: jest.fn(async (_id, after, onEvent) => {
        expect(after).toBe(0);
        onEvent(
          envelope(1, {
            type: 'assistant.message',
            text: 'Let me ask first.',
            parent_call_id: null,
          }),
        );
        onEvent(
          envelope(2, {
            type: 'question',
            question_id: 'ask-1',
            question: 'Which greeting?',
            options: [{ label: 'hello', description: null }],
            blocking: true,
            source: 'ask_user',
          }),
        );
        onEvent({
          seq: 3,
          runId: 'run-2',
          event: {
            type: 'agent.status',
            status: 'needs_input',
            ts: '2026-11-04T11:01:00Z',
          },
        });
      }),
    });
    await render(api, `/cloud-agents/agents/${waiting.id}`);
    const log = await screen.findByRole('log', { name: 'Agent events' });
    await within(log).findByText('Let me ask first.');
    expect(
      within(log).getByText('Question (blocking): Which greeting?'),
    ).toBeInTheDocument();
    expect(within(log).getByText('Agent needs input')).toBeInTheDocument();

    const form = screen.getByRole('form', { name: 'Answer ask-1' });
    await userEvent.click(within(form).getByText('bonjour'));
    await userEvent.click(within(form).getByRole('button', { name: 'Answer' }));
    await waitFor(() =>
      expect(api.reply).toHaveBeenCalledWith(waiting.id, 'ask-1', 'bonjour'),
    );

    await userEvent.click(screen.getByRole('button', { name: 'Stop' }));
    await waitFor(() => expect(api.stop).toHaveBeenCalledWith(waiting.id));
  });

  it('shows the pull request and offers a follow-up once the agent is done', async () => {
    const api = mockApi();
    await render(api, `/cloud-agents/agents/${agent.id}`);
    expect(
      (await screen.findByText('https://github.com/acme/app/pull/7')).closest(
        'a',
      ),
    ).toHaveAttribute('href', 'https://github.com/acme/app/pull/7');
    expect(
      screen.queryByRole('button', { name: 'Stop' }),
    ).not.toBeInTheDocument();
    const form = screen.getByRole('form', { name: 'Follow-up message' });
    await userEvent.type(
      within(form).getByLabelText(/Follow-up message/),
      'Also add a README',
    );
    await userEvent.click(within(form).getByRole('button', { name: 'Send' }));
    await waitFor(() =>
      expect(api.message).toHaveBeenCalledWith(agent.id, 'Also add a README'),
    );
  });
});

describe('settings', () => {
  it('sets and clears each credential without showing values', async () => {
    let summary = unset;
    const api = mockApi({
      getCredentials: jest.fn(async () => summary),
      putCredential: jest.fn(async (name, request) => {
        summary = {
          ...summary,
          ...(name === 'github'
            ? {
                github: {
                  ...summary.github,
                  connected: true,
                  login: 'octo',
                  method: 'token' as const,
                  updatedAt: null,
                },
              }
            : {
                [name]: {
                  set: true,
                  updatedAt: null,
                  ...(name === 'codex' && { kind: request.kind ?? null }),
                },
              }),
        };
        return summary;
      }),
      deleteCredential: jest.fn(async name => {
        summary = { ...summary, [name]: unset[name] };
        return summary;
      }),
    });
    await render(api, '/cloud-agents/settings');

    const card = async (title: string) =>
      (await screen.findByRole('form', {
        name: `${title} credential`,
      })) as HTMLElement;

    for (const [title, name] of [
      ['Claude Code', 'claude'],
      ['OpenCode Go', 'opencode'],
      ['GitHub', 'github'],
    ] as const) {
      const form = await card(title);
      fireEvent.change(within(form).getByLabelText(`${title} value`), {
        target: { value: `${name}-value` },
      });
      await userEvent.click(within(form).getByRole('button', { name: 'Save' }));
      await waitFor(() =>
        expect(api.putCredential).toHaveBeenCalledWith(name, {
          value: `${name}-value`,
        }),
      );
    }
    await userEvent.click(screen.getByRole('radio', { name: 'auth.json' }));
    const codex = await card('Codex');
    fireEvent.change(within(codex).getByLabelText('Codex value'), {
      target: { value: '{"tokens":{}}' },
    });
    await userEvent.click(within(codex).getByRole('button', { name: 'Save' }));
    await waitFor(() =>
      expect(api.putCredential).toHaveBeenCalledWith('codex', {
        value: '{"tokens":{}}',
        kind: 'auth_json',
      }),
    );
    expect(
      await screen.findByText('Connected as octo with a token'),
    ).toBeInTheDocument();
    expect(
      await screen.findByText('Set as ChatGPT auth.json'),
    ).toBeInTheDocument();
    expect(document.body.textContent).not.toContain('claude-value');

    for (const [title, name] of [
      ['Claude Code', 'claude'],
      ['Codex', 'codex'],
      ['OpenCode Go', 'opencode'],
      ['GitHub', 'github'],
    ] as const) {
      await userEvent.click(
        within(await card(title)).getByRole('button', { name: 'Clear' }),
      );
      await waitFor(() =>
        expect(api.deleteCredential).toHaveBeenCalledWith(name),
      );
    }
    expect(await screen.findByText('Not connected')).toBeInTheDocument();
    expect(screen.getAllByText('Not set')).toHaveLength(3);
  });

  it('offers the GitHub App connection only when one is configured', async () => {
    const api = mockApi({
      getCredentials: jest.fn(async () => ({
        ...unset,
        github: { ...unset.github, connectAvailable: true },
      })),
    });
    await render(api, '/cloud-agents/settings');
    expect(
      await screen.findByRole('button', { name: 'Connect with GitHub' }),
    ).toBeInTheDocument();
  });

  it('creates a token, shows it once, and deletes it', async () => {
    let tokens = [] as Array<{
      id: string;
      name: string;
      createdAt: string;
      lastUsedAt: string | null;
    }>;
    const api = mockApi({
      listTokens: jest.fn(async () => tokens),
      createToken: jest.fn(async name => {
        tokens = [
          {
            id: 'tok_1',
            name,
            createdAt: '2026-11-04T10:00:00Z',
            lastUsedAt: null,
          },
        ];
        return { id: 'tok_1', token: 'cat_shown_once' };
      }),
      deleteToken: jest.fn(async () => {
        tokens = [];
      }),
    });
    await render(api, '/cloud-agents/settings');
    await userEvent.type(await screen.findByLabelText('Token name'), 't3');
    await userEvent.click(screen.getByRole('button', { name: 'Create token' }));
    expect(await screen.findByTestId('new-token')).toHaveTextContent(
      'cat_shown_once',
    );
    await userEvent.click(
      await screen.findByRole('button', { name: 'Delete token t3' }),
    );
    await waitFor(() => expect(api.deleteToken).toHaveBeenCalledWith('tok_1'));
    await waitFor(() =>
      expect(screen.queryByTestId('new-token')).not.toBeInTheDocument(),
    );
  });
});
