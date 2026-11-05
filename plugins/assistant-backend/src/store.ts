import { randomBytes } from 'node:crypto';
import type { Knex } from 'knex';
import { NotFoundError } from '@backstage/errors';
import type {
  AgentSummaryItem,
  Conversation,
  ConversationItem,
} from '@alaborderie/plugin-assistant-common';

type DistributiveOmit<T, K extends PropertyKey> = T extends unknown
  ? Omit<T, K>
  : never;

/** An item before the store gives it an id, a seq, and a time. */
export type NewItem = DistributiveOmit<
  ConversationItem,
  'id' | 'conversationId' | 'seq' | 'createdAt'
>;

interface ConversationRow {
  id: string;
  owner_ref: string;
  title: string;
  created_at: string;
  updated_at: string;
}

interface ItemRow {
  id: string;
  conversation_id: string;
  seq: number;
  type: string;
  data: string;
  summary_of: string | null;
  created_at: string;
}

const nowIso = () => new Date().toISOString();
const newId = (prefix: string) =>
  `${prefix}_${randomBytes(12).toString('base64url')}`;

function toConversation(row: ConversationRow): Conversation {
  return {
    id: row.id,
    title: row.title,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function toItem(row: ItemRow): ConversationItem {
  return {
    ...(JSON.parse(row.data) as NewItem),
    id: row.id,
    conversationId: row.conversation_id,
    seq: row.seq,
    createdAt: row.created_at,
  } as ConversationItem;
}

function dataOf(item: ConversationItem | NewItem): string {
  const {
    id: _id,
    conversationId: _conversationId,
    seq: _seq,
    createdAt: _createdAt,
    ...fields
  } = item as ConversationItem;
  return JSON.stringify(fields);
}

/** Conversations and their items. Every read is scoped to the owner. */
export class Store {
  constructor(private readonly knex: Knex) {}

  async createConversation(owner: string): Promise<Conversation> {
    const now = nowIso();
    const row: ConversationRow = {
      id: newId('cv'),
      owner_ref: owner,
      title: 'New chat',
      created_at: now,
      updated_at: now,
    };
    await this.knex('conversations').insert(row);
    return toConversation(row);
  }

  async listConversations(owner: string): Promise<Conversation[]> {
    const rows: ConversationRow[] = await this.knex('conversations')
      .where({ owner_ref: owner })
      .orderBy('updated_at', 'desc')
      .limit(200);
    return rows.map(toConversation);
  }

  async getConversation(owner: string, id: string): Promise<Conversation> {
    const row: ConversationRow | undefined = await this.knex('conversations')
      .where({ id, owner_ref: owner })
      .first();
    if (!row) throw new NotFoundError(`No conversation ${id}`);
    return toConversation(row);
  }

  async setTitle(id: string, title: string): Promise<void> {
    await this.knex('conversations').where({ id }).update({ title });
  }

  async listItems(conversationId: string): Promise<ConversationItem[]> {
    const rows: ItemRow[] = await this.knex('items')
      .where({ conversation_id: conversationId })
      .orderBy('seq');
    return rows.map(toItem);
  }

  /** Appends an item at the conversation's next seq. */
  async appendItem<T extends NewItem>(
    conversationId: string,
    fields: T,
  ): Promise<Extract<ConversationItem, { type: T['type'] }>> {
    const now = nowIso();
    const row = await this.knex.transaction(async tx => {
      // The update locks the conversation row, so appends take seqs in turn.
      await tx('conversations')
        .where({ id: conversationId })
        .update({ updated_at: now });
      const last = await tx('items')
        .where({ conversation_id: conversationId })
        .max<{ seq: number | null }>('seq as seq')
        .first();
      const inserted: ItemRow = {
        id: newId('it'),
        conversation_id: conversationId,
        seq: (last?.seq ?? 0) + 1,
        type: fields.type,
        data: dataOf(fields),
        summary_of: fields.type === 'agent_summary' ? fields.agentId : null,
        created_at: now,
      };
      await tx('items').insert(inserted);
      return inserted;
    });
    return toItem(row) as Extract<ConversationItem, { type: T['type'] }>;
  }

  async updateItem(item: ConversationItem): Promise<void> {
    await this.knex('items')
      .where({ id: item.id })
      .update({ data: dataOf(item) });
  }

  async findSummary(
    conversationId: string,
    agentId: string,
  ): Promise<AgentSummaryItem | undefined> {
    const row: ItemRow | undefined = await this.knex('items')
      .where({ conversation_id: conversationId, summary_of: agentId })
      .first();
    return row ? (toItem(row) as AgentSummaryItem) : undefined;
  }
}
