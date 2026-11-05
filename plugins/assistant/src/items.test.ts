import type {
  AssistantItem,
  ConversationItem,
  UserItem,
} from '@alaborderie/plugin-assistant-common';
import { applyTurnEvent } from './items';

const base = { conversationId: 'cv_1', createdAt: '2026-11-05T10:00:00Z' };

const user = (seq: number, text = 'hi'): UserItem => ({
  ...base,
  id: `it_${seq}`,
  seq,
  type: 'user',
  text,
});

const assistant = (seq: number, text = ''): AssistantItem => ({
  ...base,
  id: `it_${seq}`,
  seq,
  type: 'assistant',
  text,
  toolCalls: [],
  status: 'streaming',
  error: null,
});

const ids = (items: ConversationItem[]) => items.map(i => i.id);

describe('applyTurnEvent', () => {
  it('appends a new item after the others', () => {
    const items = applyTurnEvent([user(1)], {
      type: 'item',
      item: assistant(2),
    });
    expect(ids(items)).toEqual(['it_1', 'it_2']);
  });

  it('inserts an item that arrives out of order at its seq', () => {
    const items = applyTurnEvent([user(1), assistant(3)], {
      type: 'item',
      item: user(2),
    });
    expect(ids(items)).toEqual(['it_1', 'it_2', 'it_3']);
  });

  it('replaces the item of the same id in place', () => {
    const items = applyTurnEvent([user(1), assistant(2, 'Hel')], {
      type: 'item',
      item: { ...assistant(2, 'Hello'), status: 'done' },
    });
    expect(items).toHaveLength(2);
    expect(items[1]).toMatchObject({ text: 'Hello', status: 'done' });
  });

  it('appends deltas to the assistant item they name', () => {
    let items: ConversationItem[] = [user(1), assistant(2), assistant(3)];
    items = applyTurnEvent(items, {
      type: 'delta',
      itemId: 'it_3',
      text: 'Hel',
    });
    items = applyTurnEvent(items, {
      type: 'delta',
      itemId: 'it_3',
      text: 'lo',
    });
    expect(items[1]).toMatchObject({ text: '' });
    expect(items[2]).toMatchObject({ text: 'Hello' });
  });

  it('ignores a delta for a user item', () => {
    const items = applyTurnEvent([user(1, 'hi')], {
      type: 'delta',
      itemId: 'it_1',
      text: '!',
    });
    expect(items[0]).toMatchObject({ text: 'hi' });
  });

  it('leaves the items unchanged on done and error', () => {
    const items = [user(1)];
    expect(applyTurnEvent(items, { type: 'done' })).toBe(items);
    expect(applyTurnEvent(items, { type: 'error', message: 'boom' })).toBe(
      items,
    );
  });
});
