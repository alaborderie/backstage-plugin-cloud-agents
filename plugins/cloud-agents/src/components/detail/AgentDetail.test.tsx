import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type {
  Agent,
  AgentEventEnvelope,
} from '@alaborderie/plugin-cloud-agents-common';
import type { CloudAgentsApi } from '../../api';
import {
  allAgents,
  childAsking,
  childDone,
  envelope,
  hub,
  hubFamily,
  iso,
  mockApi,
  needsYou,
  NOW,
  renderRoot,
  running,
  succeeded,
} from '../../__testUtils__/fixtures';

beforeAll(() => {
  // jsdom has no layout, so the page's follow-the-log scrolling has no target.
  Element.prototype.scrollIntoView = jest.fn();
});

type Stream = CloudAgentsApi['streamEvents'];

/** A stream that sends `events` and closes, as the server does for terminal agents. */
const sends =
  (events: AgentEventEnvelope[]): Stream =>
  async (_id, after, onEvent) => {
    events.filter(e => e.seq > after).forEach(onEvent);
  };

const finished = (
  seq: number,
  runId: string,
  status: 'succeeded' | 'needs_input',
) =>
  envelope(seq, runId, {
    type: 'run.finished',
    status,
    exit_code: status === 'succeeded' ? 0 : 3,
    harness_exit_code: 0,
    branch: 'cloud-agent/000000000001',
    head_sha: 'abcdef1234567',
    pushed: true,
    pr_url:
      status === 'succeeded' ? 'https://github.com/acme/acme-api/pull/7' : null,
    open_questions: [],
    usage: {
      input_tokens: 12000,
      output_tokens: 800,
      cached_input_tokens: 0,
      reasoning_tokens: 0,
      cost_usd: null,
    },
    duration_ms: 120_000,
    error: null,
  });

const question = (
  seq: number,
  id: string,
  text: string,
  options: Array<[string, string]>,
) =>
  envelope(seq, 'run-2', {
    type: 'question',
    question_id: id,
    question: text,
    options: options.map(([label, description]) => ({ label, description })),
    blocking: true,
    source: 'ask_user',
  });

const questionEvents = [
  envelope(1, 'run-2', {
    type: 'agent.run_started',
    runId: 'run-2',
    reason: 'initial',
    ts: iso(NOW),
  }),
  envelope(2, 'run-2', {
    type: 'assistant.message',
    text: 'Let me ask first.',
    parent_call_id: null,
  }),
  question(3, 'ask-1', 'Which greeting?', [
    ['hello', 'Short and informal'],
    ['bonjour', 'French, for the Paris office'],
  ]),
  question(4, 'ask-2', 'Which file holds it?', [
    ['README.md', 'Next to the setup steps'],
    ['GREETING.md', 'A file of its own'],
  ]),
  finished(5, 'run-2', 'needs_input'),
];

const composer = () => screen.getByRole('form', { name: 'Answer the agent' });

/** The API with the hub and its children next to the other agents. */
const withHub = (streamEvents: Stream = sends([])) => {
  const agents = [...allAgents, ...hubFamily];
  return mockApi({
    listAgents: jest.fn(async () => agents),
    getAgent: jest.fn(async (id: string) => agents.find(a => a.id === id)!),
    streamEvents: jest.fn(streamEvents),
  });
};

describe('agent detail', () => {
  it('shows the live timeline, the pull request, and no Stop once done', async () => {
    const api = mockApi({
      streamEvents: jest.fn(
        sends([
          envelope(1, 'run-1', {
            type: 'assistant.message',
            text: 'Added `GET /healthz`.',
            parent_call_id: null,
          }),
          finished(2, 'run-1', 'succeeded'),
        ]),
      ),
    });
    await renderRoot(api, `/cloud-agents/agents/${succeeded.id}`);

    const log = await screen.findByRole('log', { name: 'Agent events' });
    expect(await within(log).findByText('GET /healthz')).toBeInTheDocument();
    expect(within(log).getByText('Run succeeded')).toBeInTheDocument();
    expect(
      within(log).getByRole('link', { name: 'Pull request #7' }),
    ).toHaveAttribute('href', 'https://github.com/acme/acme-api/pull/7');
    expect(screen.getByRole('link', { name: 'PR #7' })).toHaveAttribute(
      'href',
      'https://github.com/acme/acme-api/pull/7',
    );
    expect(
      screen.queryByRole('button', { name: 'Stop' }),
    ).not.toBeInTheDocument();
    expect(
      screen.getByRole('form', { name: 'Follow-up message' }),
    ).toBeInTheDocument();
  });

  it('lists a hub’s children with their status, questions, and pull requests, and why the hub woke', async () => {
    const api = withHub(
      sends([
        envelope(1, 'run-10', {
          type: 'agent.wake',
          childId: childDone.id,
          childStatus: 'succeeded',
          ts: iso(NOW),
        }),
        envelope(2, 'run-11', {
          type: 'agent.run_started',
          runId: 'run-11',
          reason: 'child',
          ts: iso(NOW),
        }),
        envelope(3, 'run-11', {
          type: 'agent.status',
          status: 'waiting',
          ts: iso(NOW),
        }),
      ]),
    );
    await renderRoot(api, `/cloud-agents/agents/${hub.id}`);

    const children = await screen.findByRole('region', { name: /^Children/ });
    const rows = within(children).getAllByRole('listitem');
    expect(rows.map(row => within(row).getAllByRole('link')[0])).toEqual([
      within(children).getByRole('link', { name: childDone.title }),
      within(children).getByRole('link', { name: childAsking.title }),
    ]);
    expect(
      within(rows[0]!).getByRole('link', { name: childDone.title }),
    ).toHaveAttribute('href', `/cloud-agents/agents/${childDone.id}`);
    expect(
      within(rows[0]!).getByRole('link', { name: 'Pull request #88' }),
    ).toHaveAttribute('href', 'https://github.com/acme/acme-api/pull/88');
    expect(within(rows[0]!).getByText('Succeeded')).toBeInTheDocument();
    expect(within(rows[1]!).getByText('1 open question')).toBeInTheDocument();
    expect(within(rows[1]!).getByText('Needs you')).toBeInTheDocument();

    expect(screen.getAllByText('Waiting on children').length).toBeGreaterThan(
      0,
    );
    expect(
      screen.getByRole('form', { name: 'Follow-up message' }),
    ).toBeInTheDocument();
    const log = screen.getByRole('log', { name: 'Agent events' });
    expect(
      await within(log).findByText('Woken by a child'),
    ).toBeInTheDocument();
    expect(
      within(log).getByRole('link', { name: childDone.title }),
    ).toHaveAttribute('href', `/cloud-agents/agents/${childDone.id}`);
    expect(
      within(log).getByText(/^Run 1 · started by a child event/),
    ).toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: 'Stop' }));
    expect(
      await screen.findByText(/The hub and every child still working stop/),
    ).toBeInTheDocument();
  });

  it('opens a child from its hub with the child’s own events', async () => {
    const api = withHub(async (id, after, onEvent) => {
      const text =
        id === hub.id ? 'Splitting the objective.' : 'Adding the schema.';
      [
        envelope(1, 'run-1', {
          type: 'assistant.message',
          text,
          parent_call_id: null,
        }),
      ]
        .filter(e => e.seq > after)
        .forEach(onEvent);
    });
    await renderRoot(api, `/cloud-agents/agents/${hub.id}`);
    const children = await screen.findByRole('region', { name: /^Children/ });
    expect(
      await screen.findByText('Splitting the objective.'),
    ).toBeInTheDocument();

    await userEvent.click(
      within(children).getByRole('link', { name: childDone.title }),
    );
    expect(
      await screen.findByRole('heading', { name: childDone.title }),
    ).toBeInTheDocument();
    const log = screen.getByRole('log', { name: 'Agent events' });
    expect(
      await within(log).findByText('Adding the schema.'),
    ).toBeInTheDocument();
    expect(
      within(log).queryByText('Splitting the objective.'),
    ).not.toBeInTheDocument();
  });

  it('links a child to its hub', async () => {
    await renderRoot(withHub(), `/cloud-agents/agents/${childDone.id}`);
    const crumbs = await screen.findByRole('navigation', {
      name: 'Breadcrumb',
    });
    expect(
      await within(crumbs).findByRole('link', { name: hub.title }),
    ).toHaveAttribute('href', `/cloud-agents/agents/${hub.id}`);
    expect(
      screen.queryByRole('region', { name: /^Children/ }),
    ).not.toBeInTheDocument();
  });

  it('answers two questions one after the other', async () => {
    const api = mockApi({ streamEvents: jest.fn(sends(questionEvents)) });
    await renderRoot(api, `/cloud-agents/agents/${needsYou.id}`);

    const log = await screen.findByRole('log', { name: 'Agent events' });
    await within(log).findByText('Let me ask first.');
    expect(within(log).getByText('Which greeting?')).toBeInTheDocument();
    expect(within(log).getAllByText('blocking')).toHaveLength(2);

    expect(
      await within(composer()).findByText('Question 1 of 2'),
    ).toBeInTheDocument();
    expect(within(composer()).getByText('Which greeting?')).toBeInTheDocument();
    const hello = within(composer()).getByRole('radio', { name: /hello/ });
    const bonjour = within(composer()).getByRole('radio', { name: /bonjour/ });
    expect(hello).toHaveAccessibleName(/Short and informal/);
    expect(bonjour).toHaveAccessibleName(/French, for the Paris office/);
    expect(screen.getByRole('button', { name: 'Next' })).toBeDisabled();

    await userEvent.keyboard('2');
    expect(bonjour).toBeChecked();
    await userEvent.keyboard('1');
    expect(hello).toBeChecked();
    await userEvent.keyboard('2');
    await userEvent.click(screen.getByRole('button', { name: 'Next' }));
    await waitFor(() =>
      expect(api.reply).toHaveBeenCalledWith(needsYou.id, 'ask-1', 'bonjour'),
    );
    expect(within(log).getByText('You answered: bonjour')).toBeInTheDocument();

    expect(
      await within(composer()).findByText('Question 2 of 2'),
    ).toBeInTheDocument();
    const readme = within(composer()).getByRole('radio', {
      name: /README\.md/,
    });
    expect(readme).toHaveAccessibleName(/Next to the setup steps/);
    await userEvent.click(readme);
    await userEvent.click(
      screen.getByRole('button', { name: 'Answer and resume' }),
    );
    await waitFor(() =>
      expect(api.reply).toHaveBeenCalledWith(needsYou.id, 'ask-2', 'README.md'),
    );
    expect(api.reply).toHaveBeenCalledTimes(2);
    expect(
      await screen.findByText('Starting run 2 with your answers…'),
    ).toBeInTheDocument();
  });

  it('sends a written answer with Ctrl+Enter', async () => {
    const one: Agent = {
      ...needsYou,
      openQuestions: needsYou.openQuestions.slice(0, 1),
    };
    const api = mockApi({
      getAgent: jest.fn(async () => one),
      streamEvents: jest.fn(sends(questionEvents.slice(0, 3))),
    });
    await renderRoot(api, `/cloud-agents/agents/${one.id}`);

    const answer = await within(
      await screen.findByRole('form', { name: 'Answer the agent' }),
    ).findByRole('textbox', { name: 'Your answer' });
    await userEvent.type(answer, 'Salut, both languages');
    expect(
      screen.getByRole('button', { name: 'Answer and resume' }),
    ).toBeEnabled();
    await userEvent.keyboard('{Control>}{Enter}{/Control}');
    await waitFor(() =>
      expect(api.reply).toHaveBeenCalledWith(
        one.id,
        'ask-1',
        'Salut, both languages',
      ),
    );
  });

  it('preselects the option picked from the list', async () => {
    const api = mockApi({ streamEvents: jest.fn(sends(questionEvents)) });
    await renderRoot(api, `/cloud-agents/agents/${needsYou.id}?pick=1`);
    const bonjour = await within(
      await screen.findByRole('form', { name: 'Answer the agent' }),
    ).findByRole('radio', { name: /bonjour/ });
    expect(bonjour).toBeChecked();
  });

  it('asks before stopping a running agent', async () => {
    const api = mockApi();
    await renderRoot(api, `/cloud-agents/agents/${running.id}`);

    await userEvent.click(await screen.findByRole('button', { name: 'Stop' }));
    const dialog = await screen.findByRole('dialog', {
      name: 'Stop this agent?',
    });
    const keep = within(dialog).getByRole('button', { name: 'Keep running' });
    await waitFor(() => expect(keep).toHaveFocus());
    await userEvent.click(keep);
    await waitFor(() =>
      expect(
        screen.queryByRole('dialog', { name: 'Stop this agent?' }),
      ).not.toBeInTheDocument(),
    );
    expect(api.stop).not.toHaveBeenCalled();

    await userEvent.click(screen.getByRole('button', { name: 'Stop' }));
    await userEvent.click(
      within(
        await screen.findByRole('dialog', { name: 'Stop this agent?' }),
      ).getByRole('button', { name: 'Stop agent' }),
    );
    await waitFor(() => expect(api.stop).toHaveBeenCalledWith(running.id));
    expect(api.stop).toHaveBeenCalledTimes(1);
  });

  it('sends a follow-up and shows it before the run it starts', async () => {
    const history = [
      envelope(1, 'run-1', {
        type: 'agent.run_started',
        runId: 'run-1',
        reason: 'initial',
        ts: iso(NOW),
      }),
      finished(2, 'run-1', 'succeeded'),
    ];
    const followUp = [
      envelope(3, 'run-1', {
        type: 'agent.message',
        text: 'Also add a README',
        ts: iso(NOW),
      }),
      envelope(4, 'run-7', {
        type: 'agent.run_started',
        runId: 'run-7',
        reason: 'message',
        ts: iso(NOW),
      }),
    ];
    const streamEvents = jest
      .fn<ReturnType<Stream>, Parameters<Stream>>()
      .mockImplementationOnce(sends(history))
      .mockImplementation(sends([...history, ...followUp]));
    const api = mockApi({ streamEvents });
    await renderRoot(api, `/cloud-agents/agents/${succeeded.id}`);

    const log = await screen.findByRole('log', { name: 'Agent events' });
    await within(log).findByText('Run succeeded');
    const form = screen.getByRole('form', { name: 'Follow-up message' });
    await userEvent.type(
      within(form).getByRole('textbox', { name: 'Follow-up message' }),
      'Also add a README',
    );
    await userEvent.click(within(form).getByRole('button', { name: 'Send' }));
    await waitFor(() =>
      expect(api.message).toHaveBeenCalledWith(
        succeeded.id,
        'Also add a README',
      ),
    );

    const divider = await within(log).findByText(
      /^Run 2 · started by your follow-up/,
    );
    expect(streamEvents).toHaveBeenLastCalledWith(
      succeeded.id,
      2,
      expect.any(Function),
      expect.anything(),
    );
    const you = within(log).getByText('You').closest('li')!;
    expect(you).toHaveTextContent('Also add a README');
    const rows = within(log).getAllByRole('listitem');
    const runTwo = divider.closest('li')!;
    expect(rows).toContain(you);
    expect(rows).toContain(runTwo);
    expect(rows.indexOf(you)).toBeLessThan(rows.indexOf(runTwo));
  });
});
