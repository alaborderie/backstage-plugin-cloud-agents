import { useEffect, useRef, useState } from 'react';
import { useApi } from '@backstage/frontend-plugin-api';
import { Button, Link } from '@backstage/ui';
import {
  RiArrowRightSLine,
  RiArrowRightUpLine,
  RiBox3Line,
  RiFileTextLine,
  RiFlowChart,
  RiGitBranchLine,
  RiGlobalLine,
  RiPencilLine,
  RiPlugLine,
  RiQuestionLine,
  RiRobot2Line,
  RiSearchLine,
  RiTerminalBoxLine,
  type RemixiconComponentType,
} from '@remixicon/react';
import type {
  AgentItem,
  AgentSummaryItem,
} from '@alaborderie/plugin-assistant-common';
import {
  isTerminalAgentStatus,
  summarizeToolInput,
  type Agent,
  type AgentActivity,
  type AgentEventEnvelope,
  type ToolKind,
} from '@alaborderie/plugin-cloud-agents-common';
import { assistantApiRef } from '../api';
import { firstLine, plural } from '../format';
import { PrChip, Spinner, StatusPill, ui } from './ui';
import styles from './AgentCard.module.css';

const KIND_ICON: Record<ToolKind, RemixiconComponentType> = {
  shell: RiTerminalBoxLine,
  read: RiFileTextLine,
  edit: RiPencilLine,
  search: RiSearchLine,
  web: RiGlobalLine,
  mcp: RiPlugLine,
  task: RiFlowChart,
  other: RiBox3Line,
};

/** Events after which the agent object (status, questions, PR) may differ. */
const REFRESH_ON = new Set([
  'agent.status',
  'agent.run_started',
  'run.finished',
]);

/** Waits before reconnecting, by consecutive failures. */
const RETRY_MS = [500, 1000, 2000, 5000, 10_000, 30_000];

function wait(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise(resolve => {
    const timer = setTimeout(resolve, ms);
    signal.addEventListener('abort', () => {
      clearTimeout(timer);
      resolve();
    });
  });
}

function activityOf(envelope: AgentEventEnvelope): AgentActivity | undefined {
  const event = envelope.event;
  if (event.type === 'tool.call') {
    return {
      type: 'tool.call',
      name: event.name,
      kind: event.kind,
      summary: summarizeToolInput(event.input),
      ts: event.ts,
    };
  }
  if (event.type === 'assistant.message') {
    return {
      type: 'assistant.message',
      text: firstLine(event.text),
      ts: event.ts,
    };
  }
  return undefined;
}

const agentPath = (agentId: string) =>
  `/cloud-agents/agents/${encodeURIComponent(agentId)}`;

/**
 * Follows the agent: its object, then its event stream, resuming after the
 * last seq it saw. Stops once the agent is terminal.
 */
function useFollowedAgent(agentId: string) {
  const api = useApi(assistantApiRef);
  const [agent, setAgent] = useState<Agent>();
  const [activity, setActivity] = useState<AgentActivity | null>(null);
  const [error, setError] = useState<Error>();
  const lastSeq = useRef(0);

  useEffect(() => {
    const controller = new AbortController();
    const { signal } = controller;
    const load = async () => {
      const next = await api.getAgent(agentId);
      if (!signal.aborted) {
        setAgent(next);
        setActivity(a =>
          a && a.ts > (next.activity?.ts ?? '') ? a : next.activity,
        );
        setError(undefined);
      }
      return next;
    };
    const refresh = { running: false, again: false };
    const requestRefresh = async () => {
      if (refresh.running) {
        refresh.again = true;
        return;
      }
      refresh.running = true;
      do {
        refresh.again = false;
        await load().catch(() => {});
      } while (refresh.again && !signal.aborted);
      refresh.running = false;
    };
    const receive = (envelope: AgentEventEnvelope) => {
      if (envelope.seq <= lastSeq.current) return;
      lastSeq.current = envelope.seq;
      const next = activityOf(envelope);
      if (next) setActivity(next);
      if (REFRESH_ON.has(envelope.event.type)) requestRefresh();
    };

    (async () => {
      let failures = 0;
      for (let first = true; !signal.aborted; first = false) {
        if (!first) {
          await wait(
            RETRY_MS[Math.min(failures, RETRY_MS.length - 1)]!,
            signal,
          );
        }
        try {
          const current = await load();
          if (signal.aborted || isTerminalAgentStatus(current.status)) return;
          await api.followAgentEvents(
            agentId,
            lastSeq.current,
            receive,
            signal,
          );
          failures = 0;
        } catch (e) {
          if (signal.aborted) return;
          setError(e as Error);
          failures += 1;
        }
      }
    })();
    return () => controller.abort();
  }, [api, agentId]);

  return { agent, activity, error };
}

type SummaryState = 'idle' | 'writing' | 'failed';

/**
 * Once the agent is terminal and the conversation has no summary of it, asks
 * for one, once, and hands it to `onSummary`.
 */
function useSummary(
  conversationId: string,
  agentId: string,
  terminal: boolean,
  hasSummary: boolean,
  onSummary: (item: AgentSummaryItem) => void,
) {
  const api = useApi(assistantApiRef);
  const [state, setState] = useState<SummaryState>('idle');
  const [attempt, setAttempt] = useState(0);
  const asked = useRef(false);
  const onSummaryRef = useRef(onSummary);
  onSummaryRef.current = onSummary;

  useEffect(() => {
    if (!terminal || hasSummary || asked.current) return;
    asked.current = true;
    setState('writing');
    api.summarize(conversationId, agentId).then(
      ({ item }) => {
        setState('idle');
        if (item) onSummaryRef.current(item);
        else asked.current = false;
      },
      () => setState('failed'),
    );
  }, [api, conversationId, agentId, terminal, hasSummary, attempt]);

  const retry = () => {
    asked.current = false;
    setAttempt(a => a + 1);
  };
  return { state: hasSummary ? 'idle' : state, retry };
}

function ActivityLine(props: { activity: AgentActivity }) {
  const { activity } = props;
  const Icon =
    activity.type === 'tool.call'
      ? KIND_ICON[activity.kind]
      : RiArrowRightSLine;
  const text =
    activity.type === 'tool.call'
      ? `${activity.name} ${activity.summary}`
      : activity.text;
  return (
    <div className={styles.activity} title={text}>
      <Icon className={ui.iconXs} aria-hidden="true" />
      <span key={activity.ts}>{text}</span>
    </div>
  );
}

/** A cloud agent or hub the chat launched, live, until it finishes. */
export function AgentCard(props: {
  conversationId: string;
  item: AgentItem;
  hasSummary: boolean;
  onSummary(item: AgentSummaryItem): void;
}) {
  const { item } = props;
  const { agent, activity, error } = useFollowedAgent(item.agentId);
  const terminal = !!agent && isTerminalAgentStatus(agent.status);
  const summary = useSummary(
    props.conversationId,
    item.agentId,
    terminal,
    props.hasSummary,
    props.onSummary,
  );
  const kind = agent?.kind ?? item.agentKind;
  const KindIcon = kind === 'hub' ? RiFlowChart : RiRobot2Line;
  const questions = agent?.openQuestions ?? [];
  const children = agent?.children ?? [];

  return (
    <article
      className={styles.card}
      data-status={agent?.status}
      aria-label={`${kind === 'hub' ? 'Hub' : 'Agent'}: ${
        agent?.title ?? item.title
      }`}
    >
      <header className={styles.head}>
        <span className={styles.glyph} aria-hidden="true">
          <KindIcon className={ui.icon} />
        </span>
        <div className={styles.headMain}>
          <div className={styles.eyebrow}>
            {kind === 'hub' ? 'Hub' : 'Agent'}
          </div>
          <div className={styles.title}>{agent?.title ?? item.title}</div>
        </div>
        {agent ? (
          <StatusPill status={agent.status} />
        ) : (
          !error && <Spinner label="Loading the agent" />
        )}
      </header>

      <div className={styles.meta}>
        <span className={styles.mono}>{agent?.repo ?? item.repo}</span>
        {agent?.branch && (
          <span className={styles.branch}>
            <RiGitBranchLine className={ui.iconXs} aria-hidden="true" />
            <span className={styles.mono}>{agent.branch}</span>
          </span>
        )}
      </div>

      {!terminal && activity && <ActivityLine activity={activity} />}

      {questions.length > 0 && (
        <div className={styles.questions}>
          {questions.map(q => (
            <div key={q.questionId} className={styles.question}>
              <RiQuestionLine className={ui.iconXs} aria-hidden="true" />
              <div>
                <p>{q.question}</p>
                {q.options.length > 0 && (
                  <ul className={styles.options}>
                    {q.options.map(option => (
                      <li key={option}>{option}</li>
                    ))}
                  </ul>
                )}
              </div>
            </div>
          ))}
          <Link href={agentPath(item.agentId)} className={styles.answer}>
            Answer in Cloud agents
          </Link>
        </div>
      )}

      {children.length > 0 && (
        <div className={styles.children}>
          <div className={styles.childrenHead}>
            {plural(children.length, 'child agent')}
          </div>
          <ul>
            {children.map(child => (
              <li key={child.id}>
                <Link href={agentPath(child.id)} className={styles.childTitle}>
                  {child.title}
                </Link>
                {child.prUrl && <PrChip url={child.prUrl} />}
                <StatusPill status={child.status} />
              </li>
            ))}
          </ul>
        </div>
      )}

      {error && !agent && (
        <p className={styles.error} role="alert">
          Could not load the agent. {error.message}
        </p>
      )}
      {error && agent && !terminal && (
        <p className={styles.quiet} role="status">
          Reconnecting to the agent…
        </p>
      )}

      <footer className={styles.foot}>
        {agent?.prUrl && <PrChip url={agent.prUrl} />}
        {summary.state === 'writing' && (
          <span className={styles.quiet} role="status">
            <Spinner /> Writing the summary…
          </span>
        )}
        {summary.state === 'failed' && (
          <span className={styles.error}>
            Could not write the summary.{' '}
            <Button size="small" variant="tertiary" onPress={summary.retry}>
              Retry
            </Button>
          </span>
        )}
        <Link href={agentPath(item.agentId)} className={styles.open}>
          Open in Cloud agents
          <RiArrowRightUpLine className={ui.iconXs} aria-hidden="true" />
        </Link>
      </footer>
    </article>
  );
}
