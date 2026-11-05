import { z } from 'zod/v4';
import type {
  AuthService,
  BackstageCredentials,
  DiscoveryService,
} from '@backstage/backend-plugin-api';
import type { ActionsService } from '@backstage/backend-plugin-api/alpha';
import type { Entity } from '@backstage/catalog-model';
import type { GithubCredentialsProvider } from '@backstage/integration';
import type { CatalogService } from '@backstage/plugin-catalog-node';
import type { AgentItem, ToolName } from '@alaborderie/plugin-assistant-common';
import type { Agent } from '@alaborderie/plugin-cloud-agents-common';
import type { ToolSpec } from './chatModel';
import type { Reasoner } from './reasoning';

export interface ToolContext {
  credentials: BackstageCredentials;
  userEntityRef: string;
  signal: AbortSignal;
}

/** What the tools reach, each as the calling user where it can. */
export interface ToolDeps {
  catalog: CatalogService;
  actions: ActionsService;
  discovery: DiscoveryService;
  auth: AuthService;
  github: { apiBaseUrl: string; credentials: GithubCredentialsProvider };
  reasoner: Reasoner;
}

interface ToolDef<S extends z.ZodType> {
  description: string;
  input: S;
  run(input: z.infer<S>, ctx: ToolContext, deps: ToolDeps): Promise<unknown>;
  /** The agent card a successful call adds to the conversation. */
  launches?: (
    output: unknown,
  ) => Omit<AgentItem, 'id' | 'conversationId' | 'seq' | 'createdAt'>;
}

const defineTool = <S extends z.ZodType>(def: ToolDef<S>) => def;

/** The agent fields the model needs, without runs and per-event detail. */
function compactAgent(agent: Agent) {
  return {
    id: agent.id,
    kind: agent.kind,
    title: agent.title,
    repo: agent.repo,
    branch: agent.branch,
    status: agent.status,
    prUrl: agent.prUrl,
    parentId: agent.parentId,
    updatedAt: agent.updatedAt,
    activity: agent.activity,
    openQuestions: agent.openQuestions.map(q => ({
      questionId: q.questionId,
      question: q.question,
      options: q.options,
    })),
    children: agent.children,
  };
}

async function invoke(
  deps: ToolDeps,
  ctx: ToolContext,
  name: string,
  input: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const { output } = await deps.actions.invoke({
    id: `cloud-agents:${name}`,
    input: JSON.parse(JSON.stringify(input)),
    credentials: ctx.credentials,
  });
  return output as Record<string, unknown>;
}

async function backendGet(
  deps: ToolDeps,
  ctx: ToolContext,
  pluginId: string,
  path: string,
): Promise<Response> {
  const { token } = await deps.auth.getPluginRequestToken({
    onBehalfOf: ctx.credentials,
    targetPluginId: pluginId,
  });
  const response = await fetch(
    `${await deps.discovery.getBaseUrl(pluginId)}${path}`,
    { headers: { Authorization: `Bearer ${token}` }, signal: ctx.signal },
  );
  if (!response.ok) {
    throw new Error(`${pluginId} answered ${response.status} for ${path}`);
  }
  return response;
}

function entitySummary(entity: Entity) {
  const { metadata, spec } = entity;
  return {
    ref: `${entity.kind}:${metadata.namespace ?? 'default'}/${metadata.name}`,
    title: metadata.title,
    description: metadata.description,
    type: spec?.type,
    owner: spec?.owner,
    lifecycle: spec?.lifecycle,
    tags: metadata.tags,
  };
}

function htmlToText(html: string): string {
  const body = /<article[\s\S]*?<\/article>/i.exec(html)?.[0] ?? html;
  return body
    .replace(/<(script|style|nav|header|footer)[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<\/(p|div|h\d|li|tr|pre)>/gi, '\n')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n\s*\n+/g, '\n\n')
    .trim();
}

const GITHUB_NOISE = new Set([
  'node_id',
  '_links',
  'reactions',
  'performed_via_github_app',
  'author_association',
  'gravatar_id',
  'url',
]);

/**
 * GitHub's JSON without what a reader does not need: API URLs (html_url
 * stays), node ids, and whole user and repository objects, which become their
 * login and full name. A list of pull requests shrinks about tenfold.
 */
export function slimGithub(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(slimGithub);
  if (typeof value !== 'object' || value === null) {
    return typeof value === 'string' && value.length > 1500
      ? `${value.slice(0, 1500)}…[cut]`
      : value;
  }
  const record = value as Record<string, unknown>;
  if (typeof record.login === 'string' && 'type' in record) {
    return record.login;
  }
  if (typeof record.full_name === 'string' && 'private' in record) {
    return record.full_name;
  }
  return Object.fromEntries(
    Object.entries(record)
      .filter(
        ([key]) =>
          !GITHUB_NOISE.has(key) &&
          (key === 'html_url' || !key.endsWith('_url')),
      )
      .map(([key, inner]) => [key, slimGithub(inner)]),
  );
}

/** The account a GitHub API path is about, to pick the app installation. */
function githubOwnerOf(path: string): string | undefined {
  const direct = /^\/(?:repos|users|orgs)\/([\w.-]+)/.exec(path)?.[1];
  if (direct) return direct;
  const query = decodeURIComponent(path.split('?')[1] ?? '');
  return /(?:repo|user|org):([\w.-]+)/.exec(query)?.[1];
}

const agentId = z.string().describe('The agent id, like ag_...');

export const TOOLS = {
  search_catalog: defineTool({
    description:
      'Full-text search of the Backstage software catalog (names, titles, descriptions, tags, types). Use it when the catalog index in your instructions is not enough.',
    input: z.object({
      query: z.string().describe('Words to search for'),
      kind: z
        .string()
        .optional()
        .describe('Only this entity kind, like Component or Resource'),
      limit: z.number().int().min(1).max(50).optional(),
    }),
    async run({ query, kind, limit }, ctx, deps) {
      const { items, totalItems } = await deps.catalog.queryEntities(
        {
          ...(kind ? { filter: { kind } } : {}),
          fullTextFilter: {
            term: query,
            fields: [
              'metadata.name',
              'metadata.title',
              'metadata.description',
              'metadata.tags',
              'spec.type',
            ],
          },
          limit: limit ?? 15,
        },
        { credentials: ctx.credentials },
      );
      return { totalItems, entities: items.map(entitySummary) };
    },
  }),

  get_entity: defineTool({
    description:
      'One catalog entity with its annotations, links, spec, and relations.',
    input: z.object({
      entityRef: z
        .string()
        .describe('kind:namespace/name, like component:default/backstage'),
    }),
    async run({ entityRef }, ctx, deps) {
      const entity = await deps.catalog.getEntityByRef(entityRef, {
        credentials: ctx.credentials,
      });
      if (!entity) return { error: `No entity ${entityRef}` };
      return {
        ...entitySummary(entity),
        annotations: entity.metadata.annotations,
        links: entity.metadata.links,
        spec: entity.spec,
        relations: entity.relations?.map(r => ({
          type: r.type,
          target: r.targetRef,
        })),
      };
    },
  }),

  search_techdocs: defineTool({
    description:
      'Search the TechDocs documentation. Returns pages with a location for read_techdocs_page.',
    input: z.object({ query: z.string() }),
    async run({ query }, ctx, deps) {
      const params = new URLSearchParams({
        term: query,
        'types[0]': 'techdocs',
        pageLimit: '10',
      });
      const response = await backendGet(
        deps,
        ctx,
        'search',
        `/query?${params}`,
      );
      const body = (await response.json()) as {
        results: {
          document: {
            title?: string;
            text?: string;
            location?: string;
            name?: string;
            kind?: string;
          };
        }[];
      };
      return {
        results: body.results.map(({ document }) => ({
          title: document.title,
          entity: document.name ? `${document.kind}/${document.name}` : '',
          location: document.location,
          text: document.text?.slice(0, 400),
        })),
      };
    },
  }),

  read_techdocs_page: defineTool({
    description: 'The text of one TechDocs page, from its search location.',
    input: z.object({
      location: z
        .string()
        .describe('Like /docs/default/component/name/some/page/'),
    }),
    async run({ location }, ctx, deps) {
      const match = /^\/?docs\/([^/]+)\/([^/]+)\/([^/]+)\/?(.*?)(#.*)?$/.exec(
        location,
      );
      if (!match) return { error: 'location must start with /docs/' };
      const [, namespace, kind, name, rest = ''] = match;
      const page = rest.replace(/\/?$/, '/').replace(/^\/$/, '');
      const response = await backendGet(
        deps,
        ctx,
        'techdocs',
        `/static/docs/${namespace}/${kind}/${name}/${page}index.html`,
      );
      return { location, text: htmlToText(await response.text()) };
    },
  }),

  github_get: defineTool({
    description:
      'A read-only GET on the GitHub REST API, for repositories, files (contents API), issues, pull requests, commits, and search. Example paths: /repos/owner/name/pulls?state=open, /repos/owner/name/contents/README.md, /search/issues?q=repo:owner/name+is:open.',
    input: z.object({
      path: z
        .string()
        .regex(
          /^\/(repos|search|users|orgs)\//,
          'path must start with /repos/, /search/, /users/, or /orgs/',
        ),
    }),
    async run({ path }, ctx, deps) {
      const owner = githubOwnerOf(path);
      const { headers } = owner
        ? await deps.github.credentials.getCredentials({
            url: `https://github.com/${owner}`,
          })
        : { headers: undefined };
      const response = await fetch(`${deps.github.apiBaseUrl}${path}`, {
        headers: {
          Accept: 'application/vnd.github+json',
          'User-Agent': 'backstage-assistant',
          ...headers,
        },
        signal: ctx.signal,
      });
      const body = (await response.json()) as Record<string, unknown>;
      if (!response.ok) {
        return { error: `GitHub answered ${response.status}`, body };
      }
      if (body.encoding === 'base64' && typeof body.content === 'string') {
        const { content: _content, ...rest } = body;
        return {
          ...(slimGithub(rest) as object),
          text: Buffer.from(body.content, 'base64').toString('utf8'),
        };
      }
      return slimGithub(body);
    },
  }),

  list_agents: defineTool({
    description:
      "The user's cloud agents, newest first, with status, current activity, open questions, and PR.",
    input: z.object({
      status: z
        .enum([
          'queued',
          'running',
          'needs_input',
          'waiting',
          'succeeded',
          'failed',
          'stopped',
        ])
        .optional(),
      parentId: z.string().optional().describe('Only the children of a hub'),
      limit: z.number().int().min(1).max(50).optional(),
    }),
    async run(input, ctx, deps) {
      const { agents } = await invoke(deps, ctx, 'list-agents', {
        limit: 20,
        ...input,
      });
      return { agents: (agents as Agent[]).map(compactAgent) };
    },
  }),

  get_agent: defineTool({
    description: 'One cloud agent and the last message of its last run.',
    input: z.object({ id: agentId }),
    async run({ id }, ctx, deps) {
      const { agent, lastMessage } = await invoke(deps, ctx, 'get-agent', {
        id,
      });
      return { agent: compactAgent(agent as Agent), lastMessage };
    },
  }),

  create_agent: defineTool({
    description:
      'Launch a cloud coding agent on a GitHub repository. It works on a branch and opens a pull request. Use kind "task" for one change, "hub" for an objective that needs several agents. The page then shows a live card and a summary when it finishes.',
    input: z.object({
      repo: z.string().regex(/^[\w.-]+\/[\w.-]+$/, 'repo must be owner/name'),
      prompt: z
        .string()
        .describe(
          'A complete, self-contained instruction: what to change, where, and how to check it.',
        ),
      title: z.string().optional().describe('A short title for the card'),
      tier: z.string().optional().describe('Model tier, default flash'),
      kind: z.enum(['task', 'hub']).optional(),
    }),
    async run(input, ctx, deps) {
      const { agent } = await invoke(deps, ctx, 'create-agent', {
        tier: 'flash',
        ...input,
      });
      return { agent: compactAgent(agent as Agent) };
    },
    launches: output => {
      const { agent } = output as { agent: ReturnType<typeof compactAgent> };
      return {
        type: 'agent',
        agentId: agent.id,
        agentKind: agent.kind,
        title: agent.title,
        repo: agent.repo,
      };
    },
  }),

  reply_to_agent: defineTool({
    description: "Answer one of an agent's open questions.",
    input: z.object({
      id: agentId,
      questionId: z.string(),
      answer: z.string(),
    }),
    async run(input, ctx, deps) {
      const { agent } = await invoke(deps, ctx, 'reply-to-agent', input);
      return { agent: compactAgent(agent as Agent) };
    },
  }),

  send_agent_message: defineTool({
    description:
      'Send a follow-up instruction to an agent that is not running; it starts a new run on the same branch.',
    input: z.object({ id: agentId, text: z.string() }),
    async run(input, ctx, deps) {
      const { agent } = await invoke(deps, ctx, 'send-agent-message', input);
      return { agent: compactAgent(agent as Agent) };
    },
  }),

  stop_agent: defineTool({
    description: 'Stop an agent, and on a hub every child still working.',
    input: z.object({ id: agentId }),
    async run(input, ctx, deps) {
      const { agent } = await invoke(deps, ctx, 'stop-agent', input);
      return { agent: compactAgent(agent as Agent) };
    },
  }),

  ask_reasoning_model: defineTool({
    description:
      'Ask Claude Opus 5.5, a slower reasoning model, a hard question: design trade-offs, tricky debugging, careful analysis. Give it every fact it needs, since it sees nothing else. Takes up to a minute.',
    input: z.object({
      question: z.string(),
      context: z
        .string()
        .optional()
        .describe('Facts, code, or data the question depends on'),
    }),
    async run({ question, context }, ctx, deps) {
      return deps.reasoner.ask(
        ctx.userEntityRef,
        question,
        context,
        ctx.signal,
      );
    },
  }),
} satisfies Record<ToolName, ToolDef<z.ZodType>>;

/** The tool list sent to the chat model, in a stable order for its cache. */
export const TOOL_SPECS: ToolSpec[] = (
  Object.entries(TOOLS) as [ToolName, ToolDef<z.ZodType>][]
).map(([name, def]) => {
  const { $schema: _schema, ...parameters } = z.toJSONSchema(def.input);
  return {
    type: 'function',
    function: { name, description: def.description, parameters },
  };
});

export function isToolName(name: string): name is ToolName {
  return Object.prototype.hasOwnProperty.call(TOOLS, name);
}

export function toolDef(name: ToolName): ToolDef<z.ZodType> {
  return TOOLS[name] as ToolDef<z.ZodType>;
}
