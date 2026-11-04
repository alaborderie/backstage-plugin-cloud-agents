import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { CloudAgentsApiError } from '../../api';
import {
  credentials,
  mockApi,
  renderRoot,
  succeeded,
} from '../../__testUtils__/fixtures';

const repository = () => screen.getByRole('combobox', { name: /Repository/ });
const prompt = () =>
  screen.getByRole('textbox', { name: /What should the agent do\?/ });
const start = () => screen.getByRole('button', { name: 'Start agent' });

async function fill(repo: string, text: string) {
  await userEvent.type(
    await screen.findByRole('combobox', { name: /Repository/ }),
    repo,
  );
  await userEvent.keyboard('{Escape}');
  await userEvent.type(prompt(), text);
}

describe('new agent form', () => {
  it('starts an agent on the first tier and opens it', async () => {
    const api = mockApi();
    await renderRoot(api, '/cloud-agents/new');
    await fill('acme/acme-api', 'Add a health check endpoint');
    await waitFor(() => expect(start()).toBeEnabled());
    await userEvent.click(start());

    await waitFor(() =>
      expect(api.createAgent).toHaveBeenCalledWith({
        repo: 'acme/acme-api',
        base: 'main',
        prompt: 'Add a health check endpoint',
        tier: 'flash',
      }),
    );
    expect(
      await screen.findByRole('heading', { name: succeeded.title }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('log', { name: 'Agent events' }),
    ).toBeInTheDocument();
  });

  it('sends harness, model, and effort in custom mode', async () => {
    const api = mockApi();
    await renderRoot(api, '/cloud-agents/new');
    await fill('acme/acme-api', 'p');
    await userEvent.click(
      screen.getByRole('button', { name: 'Branch, title and custom model' }),
    );
    await userEvent.click(
      screen.getByRole('checkbox', {
        name: 'Use a harness and model instead of a tier',
      }),
    );
    await userEvent.type(
      screen.getByRole('textbox', { name: /^Model/ }),
      'opencode-go/x',
    );
    await userEvent.click(start());

    await waitFor(() =>
      expect(api.createAgent).toHaveBeenCalledWith({
        repo: 'acme/acme-api',
        base: 'main',
        prompt: 'p',
        harness: 'opencode',
        model: 'opencode-go/x',
        effort: 'high',
      }),
    );
  });

  it('points to settings when the server reports a missing credential', async () => {
    const api = mockApi({
      createAgent: jest.fn(async () => {
        throw new CloudAgentsApiError(422, {
          error: 'missing_credential',
          harness: 'opencode',
          credential: 'opencode',
        });
      }),
    });
    await renderRoot(api, '/cloud-agents/new');
    await fill('acme/acme-api', 'p');
    await waitFor(() => expect(start()).toBeEnabled());
    await userEvent.click(start());

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent(
      'Set your opencode credential in settings first.',
    );
    expect(
      within(alert).getByRole('link', { name: 'settings' }),
    ).toHaveAttribute('href', '/cloud-agents/settings');
  });

  it('starts on a ready tier and blocks a chosen tier whose credential is missing', async () => {
    const api = mockApi({
      getCredentials: jest.fn(async () => credentials({ opencode: false })),
    });
    await renderRoot(api, '/cloud-agents/new');
    await fill('acme/acme-api', 'Add a health check endpoint');

    const tiers = screen.getByRole('radiogroup', { name: 'Tier' });
    const flash = within(tiers).getByRole('radio', { name: /^Flash/ });
    const sol = within(tiers).getByRole('radio', { name: /^Sol/ });
    await waitFor(() =>
      expect(flash).toHaveAccessibleName(/opencode credential missing/),
    );
    expect(sol).toBeChecked();
    await userEvent.click(flash);
    expect(flash).toBeChecked();
    const warning = screen
      .getAllByRole('status')
      .find(el =>
        el.textContent?.includes('Your OpenCode Go credential is not set'),
      );
    expect(warning).toBeDefined();
    expect(
      within(warning!).getByRole('link', { name: 'Add it in Settings' }),
    ).toHaveAttribute('href', '/cloud-agents/settings');
    expect(start()).toBeDisabled();

    await userEvent.click(start());
    await userEvent.keyboard('{Control>}{Enter}{/Control}');
    expect(api.createAgent).not.toHaveBeenCalled();

    expect(sol).toHaveAccessibleName(/codex credential set/);
    await userEvent.click(sol);
    expect(start()).toBeEnabled();
    expect(screen.queryByText(/credential is not set/)).not.toBeInTheDocument();
    await userEvent.click(start());
    await waitFor(() =>
      expect(api.createAgent).toHaveBeenCalledWith({
        repo: 'acme/acme-api',
        base: 'main',
        prompt: 'Add a health check endpoint',
        tier: 'sol',
      }),
    );
  });

  describe('from an issue deep link', () => {
    const path =
      '/cloud-agents/new?repo=acme/garden-app&issue=42&title=Fix%20the%20login%20redirect';

    it('prefills the repository, title, and prompt, and sends them', async () => {
      const api = mockApi();
      await renderRoot(api, path);

      expect(
        await screen.findByRole('combobox', { name: /Repository/ }),
      ).toHaveValue('acme/garden-app');
      const summary = screen.getByRole('complementary', { name: 'Summary' });
      expect(
        within(summary).getByText('Fix the login redirect'),
      ).toBeInTheDocument();
      const brief = (prompt() as HTMLTextAreaElement).value;
      expect(brief).toContain('https://github.com/acme/garden-app/issues/42');

      await waitFor(() => expect(start()).toBeEnabled());
      await userEvent.click(start());
      await waitFor(() =>
        expect(api.createAgent).toHaveBeenCalledWith({
          repo: 'acme/garden-app',
          base: 'main',
          prompt: brief,
          title: 'Fix the login redirect',
          tier: 'flash',
        }),
      );
    });

    it('clears the untouched prefill when the issue is dismissed', async () => {
      await renderRoot(mockApi(), path);
      const banner = (await screen.findByText('garden-app #42')).closest(
        '[role="status"]',
      ) as HTMLElement;
      expect(banner).toHaveTextContent(
        'From garden-app #42 · Fix the login redirect',
      );

      await userEvent.click(
        within(banner).getByRole('button', { name: 'Start without the issue' }),
      );
      expect(screen.queryByText('garden-app #42')).not.toBeInTheDocument();
      expect(prompt()).toHaveValue('');
      const summary = screen.getByRole('complementary', { name: 'Summary' });
      expect(
        within(summary).queryByText('Fix the login redirect'),
      ).not.toBeInTheDocument();
      expect(within(summary).getByText('from the prompt')).toBeInTheDocument();
      expect(repository()).toHaveValue('acme/garden-app');
    });
  });
});
