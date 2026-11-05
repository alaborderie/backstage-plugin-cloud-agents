import type { BackstageCredentials } from '@backstage/backend-plugin-api';
import type { Entity } from '@backstage/catalog-model';
import type { CatalogService } from '@backstage/plugin-catalog-node';

const INDEX_TTL_MS = 5 * 60 * 1000;
const INDEX_MAX_CHARS = 40_000;

const RULES = `You are the assistant inside a Backstage developer portal. You are fast and direct: answer in a few sentences of Markdown, with lists or tables when they help. Never invent entity names, URLs, PR numbers, or agent ids.

How to answer:
- Answer straight from the catalog index below whenever it holds the answer, without a tool. When you do need a tool, first write one short sentence saying what you will check, then call the tool in the same reply.
- Catalog details the index lacks (annotations, links, relations, spec): search_catalog or get_entity.
- Documentation: search_techdocs, then read_techdocs_page for a page's text.
- GitHub (files, issues, pull requests, commits): github_get. It is read-only.
- Cloud agents: list_agents and get_agent for their state. reply_to_agent, send_agent_message, and stop_agent act on them when the user asks.
- Work in a repository (a code change, a fix, a pull request): call create_agent. Write its prompt as a complete instruction, since the agent sees nothing of this chat. Use kind "hub" only for an objective that needs several agents. Use tier flash unless the user names another. After launching, say in one sentence what you launched: the page shows the agent's live card and a summary when it finishes, so do not poll it.
- Hard questions (design trade-offs, subtle bugs, careful analysis): call ask_reasoning_model with the question and every fact it needs, then relay its answer, shortened if long. If it reports a missing or rejected credential, tell the user how to add one.
- When a tool fails, say so plainly.`;

function indexLine(entity: Entity): string {
  const { metadata, spec } = entity;
  const fields = [
    `${entity.kind}:${metadata.namespace ?? 'default'}/${metadata.name}`,
    String(spec?.type ?? ''),
    String(spec?.owner ?? ''),
    (metadata.title ? `${metadata.title}. ` : '') +
      (metadata.description ?? '').replace(/\s+/g, ' ').slice(0, 140),
  ];
  return fields.join(' | ').trimEnd();
}

/**
 * The system prompt: fixed rules, then the user's view of the catalog as one
 * line per entity, so most catalog questions need no tool call. The index is
 * cached per user and sorted, which keeps the prompt prefix stable for the
 * model's prompt cache.
 */
export class PromptBuilder {
  private readonly indexes = new Map<
    string,
    { text: string; expires: number }
  >();

  constructor(private readonly catalog: CatalogService) {}

  private async catalogIndex(
    userEntityRef: string,
    credentials: BackstageCredentials,
  ): Promise<string> {
    const cached = this.indexes.get(userEntityRef);
    if (cached && cached.expires > Date.now()) return cached.text;
    const { items } = await this.catalog.getEntities(
      {
        filter: {
          kind: [
            'Component',
            'API',
            'Resource',
            'System',
            'Domain',
            'Group',
            'User',
            'Template',
          ],
        },
        fields: [
          'kind',
          'metadata.namespace',
          'metadata.name',
          'metadata.title',
          'metadata.description',
          'spec.type',
          'spec.owner',
        ],
      },
      { credentials },
    );
    const lines = items.map(indexLine).sort();
    let text = '';
    let shown = 0;
    for (const line of lines) {
      if (text.length + line.length > INDEX_MAX_CHARS) break;
      text += `${line}\n`;
      shown += 1;
    }
    const header =
      shown < lines.length
        ? `Catalog index (${shown} of ${lines.length} entities; search_catalog finds the rest). Columns: ref | type | owner | description`
        : `Catalog index (${lines.length} entities). Columns: ref | type | owner | description`;
    const result = `${header}\n${text}`;
    this.indexes.set(userEntityRef, {
      text: result,
      expires: Date.now() + INDEX_TTL_MS,
    });
    return result;
  }

  async systemPrompt(
    userEntityRef: string,
    credentials: BackstageCredentials,
  ): Promise<string> {
    const index = await this.catalogIndex(userEntityRef, credentials).catch(
      () => 'The catalog index is unavailable; use search_catalog.',
    );
    const today = new Date().toISOString().slice(0, 10);
    return `${RULES}\n\n${index}\nThe signed-in user is ${userEntityRef}. Today is ${today}.`;
  }
}
