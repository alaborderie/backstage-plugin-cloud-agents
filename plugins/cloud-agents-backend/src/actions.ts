import type { BackstageCredentials } from '@backstage/backend-plugin-api';
import type {
  ActionsRegistryActionOptions,
  ActionsRegistryService,
} from '@backstage/backend-plugin-api/alpha';
import { InputError, NotAllowedError } from '@backstage/errors';
import {
  AGENT_KINDS,
  AGENT_STATUSES,
  type Agent,
  type AgentKind,
  type AgentStatus,
} from '@alaborderie/plugin-cloud-agents-common';

/** The zod the registry hands to schema builders. */
type Zod = Parameters<
  ActionsRegistryActionOptions<never, never>['schema']['input']
>[0];
import type { Actor, AgentService } from './agents';
import { HUB_RUN_SUBJECT_PREFIX } from './runTokens';

/**
 * The actor behind an action call: a user acts on their own agents, an active
 * hub run (a `cloud-agents-hub-run:<run id>` service principal) on its hub's
 * children only. Any other principal is refused.
 */
async function actorOf(
  agents: AgentService,
  credentials: BackstageCredentials,
): Promise<Actor> {
  const { principal } = credentials as BackstageCredentials<
    | { type: 'user'; userEntityRef: string }
    | { type: 'service'; subject: string }
    | { type: 'none' }
  >;
  if (principal.type === 'user') {
    return { type: 'user', owner: principal.userEntityRef };
  }
  if (
    principal.type === 'service' &&
    principal.subject.startsWith(HUB_RUN_SUBJECT_PREFIX)
  ) {
    return agents.hubRunActor(principal.subject);
  }
  throw new NotAllowedError(
    'Cloud agents actions act for a user or an active hub run',
  );
}

/** The agent object of docs/API.md, its main fields named for MCP clients. */
function agentSchema(z: Zod) {
  return z
    .object({
      id: z.string(),
      kind: z.string(),
      title: z.string(),
      repo: z.string(),
      branch: z.string(),
      status: z.string(),
      prUrl: z.string().nullable(),
      parentId: z.string().nullable(),
    })
    .passthrough();
}

/** The agent as the actions' JSON output; the schema above checks its shape. */
type AgentOutput = ReturnType<typeof agentSchema>['_output'];

function plain(agent: Agent): AgentOutput {
  return agent as unknown as AgentOutput;
}

/**
 * Registers the six `cloud-agents:*` actions of docs/API.md. They call the
 * same AgentService methods as the HTTP routes, so a user gets the same rules
 * and errors.
 */
export function registerActions(
  registry: ActionsRegistryService,
  agents: AgentService,
): void {
  registry.register({
    name: 'create-agent',
    title: 'Create a cloud agent',
    description:
      'Starts a cloud coding agent on a GitHub repository. kind "task" (default) does the work and opens a pull request; kind "hub" splits the prompt, its objective, into child agents. Called by a hub run, it creates a child of that hub.',
    attributes: { readOnly: false, destructive: false, idempotent: false },
    schema: {
      input: z =>
        z.object({
          repo: z.string().describe('owner/name'),
          prompt: z.string().describe('The full brief, or a hub objective'),
          tier: z.string().describe('flash, sol, or opus'),
          base: z.string().optional().describe('Default main'),
          title: z.string().optional(),
          kind: z
            .enum(AGENT_KINDS as [AgentKind, ...AgentKind[]])
            .optional()
            .describe('task (default) or hub'),
          branch: z
            .string()
            .optional()
            .describe(
              'Default cloud-agent/<short id>; give it to continue a branch',
            ),
        }),
      output: z => z.object({ agent: agentSchema(z) }),
    },
    action: async ({ input, credentials }) => {
      const actor = await actorOf(agents, credentials);
      if (actor.type === 'hub' && input.kind === 'hub') {
        throw new InputError('A hub creates tasks, not hubs');
      }
      const agent = await agents.createAgent(
        actor.owner,
        {
          repo: input.repo,
          prompt: input.prompt,
          tier: input.tier,
          ...(input.base !== undefined && { base: input.base }),
          ...(input.title !== undefined && { title: input.title }),
          ...(input.kind !== undefined && { kind: input.kind }),
          ...(input.branch !== undefined && { branch: input.branch }),
        },
        actor.type === 'hub' ? actor.hubId : null,
      );
      return { output: { agent: plain(agent) } };
    },
  });

  registry.register({
    name: 'list-agents',
    title: 'List cloud agents',
    description:
      'Lists your cloud agents, newest first, children of hubs included. Filter by status or by parentId (the children of one hub). Called by a hub run, it lists that hub’s children.',
    attributes: { readOnly: true, destructive: false, idempotent: true },
    schema: {
      input: z =>
        z.object({
          status: z
            .enum(AGENT_STATUSES as [AgentStatus, ...AgentStatus[]])
            .optional(),
          parentId: z.string().optional(),
          limit: z.number().int().min(1).max(500).optional(),
        }),
      output: z => z.object({ agents: z.array(agentSchema(z)) }),
    },
    action: async ({ input, credentials }) => {
      const actor = await actorOf(agents, credentials);
      if (
        actor.type === 'hub' &&
        input.parentId !== undefined &&
        input.parentId !== actor.hubId
      ) {
        throw new NotAllowedError('not_your_child');
      }
      const parentId = actor.type === 'hub' ? actor.hubId : input.parentId;
      const list = await agents.listAgents(actor.owner, {
        ...(input.status !== undefined && { status: input.status }),
        ...(parentId !== undefined && { parentId }),
        ...(input.limit !== undefined && { limit: input.limit }),
      });
      return { output: { agents: list.map(plain) } };
    },
  });

  registry.register({
    name: 'get-agent',
    title: 'Get a cloud agent',
    description:
      'Reads one cloud agent: status, runs, open questions, pull request, children of a hub, and lastMessage, the last assistant message of its last run (at most 8000 characters).',
    attributes: { readOnly: true, destructive: false, idempotent: true },
    schema: {
      input: z => z.object({ id: z.string() }),
      output: z =>
        z.object({
          agent: agentSchema(z),
          lastMessage: z.string().nullable(),
        }),
    },
    action: async ({ input, credentials }) => {
      const actor = await actorOf(agents, credentials);
      await agents.assertReachable(actor, input.id);
      const { agent, lastMessage } = await agents.getAgentWithLastMessage(
        actor.owner,
        input.id,
      );
      return { output: { agent: plain(agent), lastMessage } };
    },
  });

  registry.register({
    name: 'reply-to-agent',
    title: 'Answer a cloud agent question',
    description:
      'Answers one open question of an agent that is needs_input. The answer that completes the set starts the next run on the same branch.',
    attributes: { readOnly: false, destructive: false, idempotent: false },
    schema: {
      input: z =>
        z.object({
          id: z.string(),
          questionId: z.string(),
          answer: z.string().min(1),
        }),
      output: z => z.object({ agent: agentSchema(z) }),
    },
    action: async ({ input, credentials }) => {
      const actor = await actorOf(agents, credentials);
      await agents.assertReachable(actor, input.id);
      await agents.reply(actor.owner, input.id, input.questionId, input.answer);
      return {
        output: { agent: plain(await agents.getAgent(actor.owner, input.id)) },
      };
    },
  });

  registry.register({
    name: 'send-agent-message',
    title: 'Send a cloud agent a follow-up',
    description:
      'Starts a follow-up run of an agent on the same branch with this message. Refused while the agent has an active run.',
    attributes: { readOnly: false, destructive: false, idempotent: false },
    schema: {
      input: z => z.object({ id: z.string(), text: z.string().min(1) }),
      output: z => z.object({ agent: agentSchema(z) }),
    },
    action: async ({ input, credentials }) => {
      const actor = await actorOf(agents, credentials);
      await agents.assertReachable(actor, input.id);
      await agents.message(actor.owner, input.id, input.text);
      return {
        output: { agent: plain(await agents.getAgent(actor.owner, input.id)) },
      };
    },
  });

  registry.register({
    name: 'stop-agent',
    title: 'Stop a cloud agent',
    description:
      'Stops an agent: deletes its active Job and sets it to stopped. Stopping a hub also stops every child that is not finished.',
    attributes: { readOnly: false, destructive: true, idempotent: true },
    schema: {
      input: z => z.object({ id: z.string() }),
      output: z => z.object({ agent: agentSchema(z) }),
    },
    action: async ({ input, credentials }) => {
      const actor = await actorOf(agents, credentials);
      await agents.assertReachable(actor, input.id);
      await agents.stop(actor.owner, input.id, {
        byHub: actor.type === 'hub',
      });
      return {
        output: { agent: plain(await agents.getAgent(actor.owner, input.id)) },
      };
    },
  });
}
