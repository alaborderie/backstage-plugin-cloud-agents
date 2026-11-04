import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import {
  allAgents,
  failed,
  mockApi,
  needsYou,
  queued,
  renderRoot,
  running,
  stopped,
  succeeded,
} from '../../__testUtils__/fixtures';

const region = (name: string) => screen.getByRole('region', { name });
const titles = (name: string) =>
  within(region(name))
    .queryAllByRole('link')
    .map(link => link.textContent)
    .filter(text => allAgents.some(a => a.title === text));

describe('agents list', () => {
  it('groups agents into needs you, in progress, and by day', async () => {
    await renderRoot(mockApi(), '/cloud-agents');
    await screen.findByRole('link', { name: succeeded.title });

    expect(titles('Needs you')).toEqual([needsYou.title]);
    expect(titles('In progress')).toEqual([running.title, queued.title]);
    expect(titles('Today')).toEqual([succeeded.title]);
    expect(titles('Yesterday')).toEqual([failed.title]);
    expect(titles('Earlier')).toEqual([stopped.title]);
    expect(
      screen.getByRole('tab', { name: 'Agents , 1 agent needs you' }),
    ).toBeInTheDocument();
  });

  it('links each agent, shows its status as a word, and links its pull request', async () => {
    await renderRoot(mockApi(), '/cloud-agents');
    await screen.findByRole('heading', { name: 'Today' });
    const today = region('Today');
    expect(
      within(today).getByRole('link', { name: succeeded.title }),
    ).toHaveAttribute('href', `/cloud-agents/agents/${succeeded.id}`);
    expect(within(today).getByText('Succeeded')).toBeInTheDocument();
    expect(
      within(today).getByRole('link', { name: 'Pull request #7' }),
    ).toHaveAttribute('href', 'https://github.com/acme/acme-api/pull/7');
    expect(within(region('Yesterday')).getByText('Failed')).toBeInTheDocument();
    expect(within(region('Earlier')).getByText('Stopped')).toBeInTheDocument();

    const progress = region('In progress');
    expect(within(progress).getByText('Running')).toBeInTheDocument();
    expect(within(progress).getByText('Queued')).toBeInTheDocument();
    expect(within(progress).getByTitle('bash yarn test')).toBeInTheDocument();
    expect(
      within(progress).getByRole('timer', { name: 'Elapsed' }),
    ).toHaveTextContent(/^6:\d\d$/);
  });

  it('shows what a waiting agent asks, with options that open the answer', async () => {
    await renderRoot(mockApi(), '/cloud-agents');
    await screen.findByRole('heading', { name: 'Needs you' });
    const needs = within(region('Needs you')).getByRole('article');
    expect(within(needs).getByText('Needs you')).toBeInTheDocument();
    expect(within(needs).getByText('Which greeting?')).toBeInTheDocument();
    expect(within(needs).getByRole('link', { name: 'hello' })).toHaveAttribute(
      'href',
      `/cloud-agents/agents/${needsYou.id}?pick=0`,
    );
    expect(
      within(needs).getByRole('link', { name: 'bonjour' }),
    ).toHaveAttribute('href', `/cloud-agents/agents/${needsYou.id}?pick=1`);
    expect(within(needs).getByText('+1 more question')).toBeInTheDocument();
  });

  it('narrows the list by search and status, and clears the filters', async () => {
    await renderRoot(mockApi(), '/cloud-agents');
    await screen.findByRole('link', { name: succeeded.title });

    await userEvent.type(
      screen.getByRole('searchbox', { name: 'Search agents' }),
      'garden',
    );
    expect(
      screen.getByRole('link', { name: needsYou.title }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('link', { name: running.title }),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole('link', { name: succeeded.title }),
    ).not.toBeInTheDocument();

    const filters = screen.getByRole('radiogroup', {
      name: 'Filter by status',
    });
    await userEvent.click(
      within(filters).getByRole('radio', { name: /^Running/ }),
    );
    expect(
      screen.getByRole('link', { name: running.title }),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole('link', { name: needsYou.title }),
    ).not.toBeInTheDocument();

    await userEvent.click(
      within(filters).getByRole('radio', { name: /^Succeeded/ }),
    );
    expect(screen.getByText('No agents match')).toBeInTheDocument();
    expect(screen.getByText('Nothing matches “garden”.')).toBeInTheDocument();

    await userEvent.click(
      screen.getByRole('button', { name: 'Clear filters' }),
    );
    for (const agent of allAgents) {
      expect(
        screen.getByRole('link', { name: agent.title }),
      ).toBeInTheDocument();
    }
    expect(
      screen.getByRole('searchbox', { name: 'Search agents' }),
    ).toHaveValue('');
    expect(within(filters).getByRole('radio', { name: /^All/ })).toBeChecked();
  });

  it('invites a first agent when there are none', async () => {
    await renderRoot(
      mockApi({ listAgents: jest.fn(async () => []) }),
      '/cloud-agents',
    );
    expect(await screen.findByText('No agents yet')).toBeInTheDocument();
    expect(
      screen.getByRole('link', { name: 'Start your first agent' }),
    ).toHaveAttribute('href', '/cloud-agents/new');
  });

  it('reports a failed load and retries', async () => {
    const api = mockApi({
      listAgents: jest
        .fn()
        .mockRejectedValueOnce(new Error('Service unavailable'))
        .mockResolvedValue([succeeded]),
    });
    await renderRoot(api, '/cloud-agents');
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('Could not load your agents');
    expect(alert).toHaveTextContent('Service unavailable');

    await userEvent.click(
      within(alert).getByRole('button', { name: 'Try again' }),
    );
    expect(
      await screen.findByRole('link', { name: succeeded.title }),
    ).toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });
});
