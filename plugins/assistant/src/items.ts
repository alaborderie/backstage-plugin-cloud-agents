import type {
  ConversationItem,
  TurnEvent,
} from '@alaborderie/plugin-assistant-common';

/**
 * The one place a conversation's items change. `item` replaces the item of
 * the same id or inserts it in seq order; `delta` appends to a streaming
 * assistant item. `done` and `error` leave the items as they are.
 */
export function applyTurnEvent(
  items: ConversationItem[],
  event: TurnEvent,
): ConversationItem[] {
  switch (event.type) {
    case 'item': {
      const rest = items.filter(i => i.id !== event.item.id);
      const at = rest.findIndex(i => i.seq > event.item.seq);
      if (at === -1) return [...rest, event.item];
      return [...rest.slice(0, at), event.item, ...rest.slice(at)];
    }
    case 'delta':
      return items.map(i =>
        i.id === event.itemId && i.type === 'assistant'
          ? { ...i, text: i.text + event.text }
          : i,
      );
    default:
      return items;
  }
}
