import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { TurnEvent } from '@alaborderie/plugin-assistant-common';
import {
  assistantItem,
  deferred,
  mockApi,
  render,
  userItem,
} from '../__testUtils__/fixtures';
import { AssistantPage } from './AssistantPage';

const QUESTION = 'Which of my components are Rust services?';

describe('AssistantPage', () => {
  it('creates a conversation, sends the first message, and streams the answer', async () => {
    const midway = deferred();
    const api = mockApi({
      sendMessage: jest.fn(
        async (_id: string, text: string, onEvent: (e: TurnEvent) => void) => {
          onEvent({ type: 'item', item: userItem(1, text) });
          onEvent({ type: 'item', item: assistantItem(2, '') });
          onEvent({ type: 'delta', itemId: 'it_2', text: 'Two Rust ' });
          await midway.promise;
          onEvent({
            type: 'delta',
            itemId: 'it_2',
            text: 'services: **keyroll**.',
          });
          onEvent({
            type: 'item',
            item: assistantItem(2, 'Two Rust services: **keyroll**.', 'done'),
          });
          onEvent({ type: 'done' });
        },
      ),
    });
    await render(<AssistantPage />, api);

    await userEvent.type(
      screen.getByRole('textbox', { name: 'Message the assistant' }),
      `${QUESTION}{Enter}`,
    );

    await waitFor(() =>
      expect(api.createConversation).toHaveBeenCalledTimes(1),
    );
    await waitFor(() =>
      expect(api.sendMessage).toHaveBeenCalledWith(
        'cv_1',
        QUESTION,
        expect.any(Function),
        expect.any(AbortSignal),
      ),
    );
    expect(await screen.findByText(QUESTION)).toBeInTheDocument();
    expect(await screen.findByText('Two Rust')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Stop' })).toBeInTheDocument();
    expect(
      screen.getByRole('textbox', { name: 'Message the assistant' }),
    ).toBeDisabled();

    midway.resolve();
    expect(await screen.findByText('keyroll')).toBeInTheDocument();
    expect(screen.getByText(/Two Rust services:/)).toBeInTheDocument();
    expect(
      await screen.findByRole('button', { name: 'Send' }),
    ).toBeInTheDocument();
    expect(api.sendMessage).toHaveBeenCalledTimes(1);
  });

  it('sends an example prompt from the empty state', async () => {
    const api = mockApi();
    await render(<AssistantPage />, api);
    await userEvent.click(
      screen.getByRole('button', { name: 'What are my cloud agents doing?' }),
    );
    await waitFor(() =>
      expect(api.sendMessage).toHaveBeenCalledWith(
        'cv_1',
        'What are my cloud agents doing?',
        expect.any(Function),
        expect.any(AbortSignal),
      ),
    );
  });

  it('reopens the conversation the URL names', async () => {
    const api = mockApi({
      listConversations: jest.fn(async () => [
        {
          id: 'cv_7',
          title: 'Rust services',
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        },
      ]),
      getConversation: jest.fn(async (id: string) => ({
        conversation: {
          id,
          title: 'Rust services',
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        },
        items: [
          userItem(1, QUESTION),
          assistantItem(2, 'Only keyroll.', 'done'),
        ],
      })),
    });
    await render(<AssistantPage />, api, '/assistant/cv_7');
    expect(await screen.findByText('Only keyroll.')).toBeInTheDocument();
    expect(api.getConversation).toHaveBeenCalledWith('cv_7');
    expect(
      await screen.findByRole('link', { name: /Rust services/ }),
    ).toHaveAttribute('aria-current', 'page');
  });

  it('keeps the draft and shows the error when the turn is refused', async () => {
    const api = mockApi({
      sendMessage: jest.fn(async () => {
        throw new Error('A turn is already running');
      }),
    });
    await render(<AssistantPage />, api);
    const field = screen.getByRole('textbox', {
      name: 'Message the assistant',
    });
    await userEvent.type(field, `${QUESTION}{Enter}`);
    expect(
      await screen.findByText('A turn is already running'),
    ).toBeInTheDocument();
    expect(field).toHaveValue(QUESTION);
  });
});
