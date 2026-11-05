import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderTestApp } from '@backstage/frontend-test-utils';
import catalogPlugin from '@backstage/plugin-catalog/alpha';
import { catalogApiMock } from '@backstage/plugin-catalog-react/testUtils';
import { entities } from '../dev/entities';
import { cloudAgentsPlugin } from './plugin';
import { cloudAgentsApiRef } from './api';
import { mockApi } from './__testUtils__/fixtures';

it.each(['keyroll', 'keyroll-api'])(
  'discovers the action on %s and opens a prefilled form',
  async name => {
    renderTestApp({
      features: [catalogPlugin, cloudAgentsPlugin],
      apis: [catalogApiMock({ entities }), [cloudAgentsApiRef, mockApi()]],
      initialRouteEntries: [`/catalog/default/component/${name}`],
    });
    const action = await screen.findByRole('link', { name: 'New agent' });
    const url = new URL(action.getAttribute('href')!, 'http://localhost');
    expect(url.pathname).toBe('/cloud-agents/new');
    expect(url.searchParams.get('repo')).toBe('alaborderie/keyroll');
    const prompt = url.searchParams.get('prompt')!;
    expect(prompt).toContain(`Entity: component:default/${name}`);
    expect(prompt).toContain('Kind: Component');
    expect(prompt).toContain('Description:');
    expect(prompt).toContain('Catalog page:');
    expect(prompt).toContain('Task:\n');
    const expected =
      name === 'keyroll-api'
        ? [
            'Title: Keyroll API',
            'Type: api',
            'Link: API host: https://keyroll.example.com',
            'backstage.io/kubernetes-namespace: keyroll',
            'backstage.io/kubernetes-id: keyroll-api',
            'backstage.io/kubernetes-label-selector: app=keyroll-api',
          ]
        : ['Type: repository'];
    for (const line of expected) expect(prompt).toContain(line);
    await userEvent.click(action);
    expect(
      await screen.findByRole('combobox', { name: /Repository/ }),
    ).toHaveValue('alaborderie/keyroll');
    expect(
      screen.getByRole('textbox', { name: /What should the agent do/ }),
    ).toHaveValue(prompt);
  },
);

it('omits the action when the entity has no GitHub project slug', async () => {
  renderTestApp({
    features: [catalogPlugin, cloudAgentsPlugin],
    apis: [catalogApiMock({ entities }), [cloudAgentsApiRef, mockApi()]],
    initialRouteEntries: ['/catalog/default/component/without-repo'],
  });
  await screen.findByText('Workload without a repository');
  expect(
    screen.queryByRole('link', { name: 'New agent' }),
  ).not.toBeInTheDocument();
});
