import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type {
  AccessToken,
  CredentialName,
  CredentialsSummary,
  PutCredentialRequest,
} from '@alaborderie/plugin-cloud-agents-common';
import { CloudAgentsApiError } from '../../api';
import { mockApi, renderRoot, unset } from '../../__testUtils__/fixtures';

/** A credentials store behind the mock API, like the backend's. */
function store() {
  let summary: CredentialsSummary = unset;
  return {
    getCredentials: jest.fn(async () => summary),
    putCredential: jest.fn(
      async (name: CredentialName, request: PutCredentialRequest) => {
        if (name === 'github') {
          summary = {
            ...summary,
            github: {
              ...summary.github,
              connected: true,
              login: 'acme-dev',
              method: 'token',
            },
          };
        } else {
          summary = {
            ...summary,
            [name]: {
              set: true,
              updatedAt: null,
              ...(name === 'codex' && { kind: request.kind ?? null }),
            },
          };
        }
        return summary;
      },
    ),
    deleteCredential: jest.fn(async (name: CredentialName) => {
      summary = { ...summary, [name]: unset[name] };
      return summary;
    }),
  };
}

const SECRET = 'sk-acme-very-secret';

function expectSecretHidden() {
  expect(document.body).not.toHaveTextContent(SECRET);
  for (const input of document.querySelectorAll('input, textarea')) {
    expect((input as HTMLInputElement).value).not.toContain(SECRET);
  }
}

describe('settings', () => {
  it('sets and clears each harness credential without showing its value', async () => {
    const api = mockApi(store());
    await renderRoot(api, '/cloud-agents/settings');

    for (const [title, name] of [
      ['Claude Code', 'claude'],
      ['OpenCode Go', 'opencode'],
      ['Codex', 'codex'],
    ] as const) {
      await userEvent.click(
        await screen.findByRole('button', { name: `Add ${title}` }),
      );
      const form = screen.getByRole('form', { name: `${title} credential` });
      await userEvent.type(
        within(form).getByLabelText(`${title} value`),
        `${SECRET}-${name}`,
      );
      await userEvent.click(within(form).getByRole('button', { name: 'Save' }));
      await waitFor(() =>
        expect(api.putCredential).toHaveBeenCalledWith(name, {
          value: `${SECRET}-${name}`,
          ...(name === 'codex' && { kind: 'api_key' }),
        }),
      );
      expect(
        await screen.findByRole('button', { name: `Replace ${title}` }),
      ).toBeInTheDocument();
    }
    expect(screen.getByText('Set as OpenAI API key')).toBeInTheDocument();
    expectSecretHidden();

    await userEvent.click(
      screen.getByRole('button', { name: 'Replace Codex' }),
    );
    const codex = screen.getByRole('form', { name: 'Codex credential' });
    await userEvent.click(
      within(codex).getByRole('radio', { name: 'ChatGPT auth.json' }),
    );
    await userEvent.click(
      within(codex).getByRole('textbox', { name: 'Codex value' }),
    );
    await userEvent.paste(`{"tokens":{"id":"${SECRET}"}}`);
    await userEvent.click(within(codex).getByRole('button', { name: 'Save' }));
    await waitFor(() =>
      expect(api.putCredential).toHaveBeenLastCalledWith('codex', {
        value: `{"tokens":{"id":"${SECRET}"}}`,
        kind: 'auth_json',
      }),
    );
    expect(
      await screen.findByText('Set as ChatGPT auth.json'),
    ).toBeInTheDocument();
    expectSecretHidden();

    for (const [title, name] of [
      ['Claude Code', 'claude'],
      ['Codex', 'codex'],
      ['OpenCode Go', 'opencode'],
    ] as const) {
      await userEvent.click(
        screen.getByRole('button', { name: `Clear ${title}` }),
      );
      await userEvent.click(
        screen.getByRole('button', { name: 'Clear credential' }),
      );
      await waitFor(() =>
        expect(api.deleteCredential).toHaveBeenCalledWith(name),
      );
      expect(
        await screen.findByRole('button', { name: `Add ${title}` }),
      ).toBeInTheDocument();
    }
    expect(screen.getAllByText('Not set')).toHaveLength(4);
  });

  it('sets and clears the Anthropic API key, and shows why the API refused one', async () => {
    const backing = store();
    const putCredential = backing.putCredential;
    const api = mockApi({
      ...backing,
      putCredential: jest.fn(
        async (name: CredentialName, request: PutCredentialRequest) => {
          if (request.value.startsWith('sk-ant-oat')) {
            throw new CloudAgentsApiError(400, {
              error: {
                name: 'InputError',
                message: 'This is a Claude Code setup-token, not an API key',
              },
            });
          }
          return putCredential(name, request);
        },
      ),
    });
    await renderRoot(api, '/cloud-agents/settings');

    await userEvent.click(
      await screen.findByRole('button', { name: 'Add Anthropic API key' }),
    );
    const form = screen.getByRole('form', {
      name: 'Anthropic API key credential',
    });
    const field = within(form).getByLabelText('Anthropic API key value');
    await userEvent.type(field, 'sk-ant-oat01-setup-token');
    await userEvent.click(within(form).getByRole('button', { name: 'Save' }));
    expect(
      await within(form).findByText(
        'This is a Claude Code setup-token, not an API key',
      ),
    ).toBeInTheDocument();

    await userEvent.clear(field);
    await userEvent.type(field, `sk-ant-api03-${SECRET}`);
    await userEvent.click(within(form).getByRole('button', { name: 'Save' }));
    await waitFor(() =>
      expect(api.putCredential).toHaveBeenLastCalledWith('anthropic', {
        value: `sk-ant-api03-${SECRET}`,
      }),
    );
    expect(
      await screen.findByRole('button', { name: 'Replace Anthropic API key' }),
    ).toBeInTheDocument();
    expectSecretHidden();

    await userEvent.click(
      screen.getByRole('button', { name: 'Clear Anthropic API key' }),
    );
    await userEvent.click(
      screen.getByRole('button', { name: 'Clear credential' }),
    );
    await waitFor(() =>
      expect(api.deleteCredential).toHaveBeenCalledWith('anthropic'),
    );
    expect(
      await screen.findByRole('button', { name: 'Add Anthropic API key' }),
    ).toBeInTheDocument();
  });

  it('stores a GitHub token and disconnects', async () => {
    const api = mockApi(store());
    await renderRoot(api, '/cloud-agents/settings');

    expect(await screen.findByText('Not connected')).toBeInTheDocument();
    await userEvent.click(
      screen.getByRole('button', { name: 'Use a token instead' }),
    );
    const form = screen.getByRole('form', { name: 'GitHub credential' });
    await userEvent.type(within(form).getByLabelText('GitHub value'), SECRET);
    await userEvent.click(
      within(form).getByRole('button', { name: 'Save token' }),
    );
    await waitFor(() =>
      expect(api.putCredential).toHaveBeenCalledWith('github', {
        value: SECRET,
      }),
    );
    expect(
      await screen.findByText('Connected as acme-dev'),
    ).toBeInTheDocument();
    expect(
      screen.getByText('Personal token, never refreshed'),
    ).toBeInTheDocument();
    expectSecretHidden();

    await userEvent.click(screen.getByRole('button', { name: 'Disconnect' }));
    expect(api.deleteCredential).not.toHaveBeenCalled();
    await userEvent.click(
      screen.getByRole('button', { name: 'Disconnect GitHub' }),
    );
    await waitFor(() =>
      expect(api.deleteCredential).toHaveBeenCalledWith('github'),
    );
    expect(await screen.findByText('Not connected')).toBeInTheDocument();
  });

  it('offers the GitHub App connection only when one is configured', async () => {
    await renderRoot(mockApi(store()), '/cloud-agents/settings');
    await screen.findByText('Not connected');
    expect(
      screen.queryByRole('button', { name: 'Connect with GitHub' }),
    ).not.toBeInTheDocument();
  });

  it('shows Connect with GitHub when the GitHub App is configured', async () => {
    const api = mockApi({
      getCredentials: jest.fn(async () => ({
        ...unset,
        github: { ...unset.github, connectAvailable: true },
      })),
    });
    await renderRoot(api, '/cloud-agents/settings');
    expect(
      await screen.findByRole('button', { name: 'Connect with GitHub' }),
    ).toBeInTheDocument();
  });

  it('creates a token, shows it once, and revokes it', async () => {
    let tokens: AccessToken[] = [];
    const api = mockApi({
      listTokens: jest.fn(async () => tokens),
      createToken: jest.fn(async (name: string) => {
        tokens = [
          {
            id: 'tok_1',
            name,
            createdAt: new Date().toISOString(),
            lastUsedAt: null,
          },
        ];
        return { id: 'tok_1', token: 'cat_shown_once' };
      }),
      deleteToken: jest.fn(async () => {
        tokens = [];
      }),
    });
    await renderRoot(api, '/cloud-agents/settings');

    await userEvent.type(
      await screen.findByRole('textbox', { name: 'Token name' }),
      'T3 bridge',
    );
    await userEvent.click(screen.getByRole('button', { name: 'Create token' }));
    await waitFor(() =>
      expect(api.createToken).toHaveBeenCalledWith('T3 bridge'),
    );
    expect(await screen.findByTestId('new-token')).toHaveTextContent(
      'cat_shown_once',
    );

    await userEvent.click(
      await screen.findByRole('button', { name: 'Revoke token T3 bridge' }),
    );
    expect(api.deleteToken).not.toHaveBeenCalled();
    await userEvent.click(screen.getByRole('button', { name: 'Revoke' }));
    await waitFor(() => expect(api.deleteToken).toHaveBeenCalledWith('tok_1'));
    await waitFor(() =>
      expect(screen.queryByTestId('new-token')).not.toBeInTheDocument(),
    );
    expect(await screen.findByText(/^No tokens\./)).toBeInTheDocument();
  });
});
