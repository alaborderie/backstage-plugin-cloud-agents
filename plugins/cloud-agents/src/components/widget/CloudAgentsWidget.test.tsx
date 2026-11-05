import { screen } from '@testing-library/react';
import { renderInTestApp } from '@backstage/frontend-test-utils';
import { cloudAgentsApiRef, type CloudAgentsApi } from '../../api';
import { rootRouteRef } from '../../routes';
import {
  failed,
  hub,
  iso,
  mockApi,
  needsYou,
  NOW,
  queued,
  running,
  stopped,
  succeeded,
} from '../../__testUtils__/fixtures';
import { CloudAgentsWidget } from './CloudAgentsWidget';

const failedToday = {
  ...failed,
  id: 'ag_000000000007',
  title: 'Retry the export',
  updatedAt: iso(NOW),
};

function render(api: CloudAgentsApi) {
  return renderInTestApp(<CloudAgentsWidget />, {
    apis: [[cloudAgentsApiRef, api]],
    mountedRoutes: { '/cloud-agents': rootRouteRef },
  });
}

describe('CloudAgentsWidget', () => {
  it('puts agents that need you first, then running and queued ones, and sums up today', async () => {
    const api = mockApi({
      listAgents: jest.fn(async () => [
        queued,
        succeeded,
        running,
        failed,
        stopped,
        needsYou,
        failedToday,
      ]),
    });
    await render(api);

    const answer = await screen.findByRole('link', {
      name: `Answer ${needsYou.title}`,
    });
    expect(answer).toHaveAttribute(
      'href',
      `/cloud-agents/agents/${needsYou.id}`,
    );
    expect(screen.getByText('Which greeting?')).toBeInTheDocument();

    expect(screen.getByTitle('bash yarn test')).toBeInTheDocument();
    expect(screen.getByRole('timer', { name: 'Elapsed' })).toHaveTextContent(
      /^6:\d\d$/,
    );
    expect(screen.getByText('Queued')).toBeInTheDocument();

    const shown = screen
      .getAllByRole('link')
      .map(link => link.textContent)
      .filter(text =>
        [needsYou, running, queued, succeeded, failedToday].some(
          a => a.title === text,
        ),
      );
    expect(shown).toEqual([needsYou.title, running.title, queued.title]);

    expect(
      screen.getByText('2 agents finished today · 1 pull request opened'),
    ).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'All agents' })).toHaveAttribute(
      'href',
      '/cloud-agents',
    );
  });

  it('lists a hub waiting on its children after the running agents', async () => {
    await render(mockApi({ listAgents: jest.fn(async () => [hub, running]) }));
    const link = await screen.findByRole('link', { name: hub.title });
    expect(link).toHaveAttribute('href', `/cloud-agents/agents/${hub.id}`);
    expect(screen.getByText('Waiting on children')).toBeInTheDocument();
    expect(
      screen
        .getAllByRole('link')
        .map(l => l.textContent)
        .filter(text => text === hub.title || text === running.title),
    ).toEqual([running.title, hub.title]);
  });

  it('offers a new agent when nothing is running', async () => {
    await render(mockApi({ listAgents: jest.fn(async () => [succeeded]) }));
    expect(await screen.findByText('No agents running')).toBeInTheDocument();
    expect(
      screen.getByText('1 agent finished today · 1 pull request opened'),
    ).toBeInTheDocument();
    for (const link of screen.getAllByRole('link', { name: 'New agent' })) {
      expect(link).toHaveAttribute('href', '/cloud-agents/new');
    }
  });

  it('reports an unreachable backend', async () => {
    await render(
      mockApi({
        listAgents: jest.fn(async () =>
          Promise.reject(new Error('Bad gateway')),
        ),
      }),
    );
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('Agents are unreachable');
    expect(alert).toHaveTextContent('Bad gateway');
  });
});
