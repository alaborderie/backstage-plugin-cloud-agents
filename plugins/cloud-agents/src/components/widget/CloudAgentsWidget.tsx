import { useEffect, useRef } from 'react';
import { Link } from 'react-router-dom';
import { Button, ButtonLink, Skeleton } from '@backstage/ui';
import { useRouteRef } from '@backstage/frontend-plugin-api';
import {
  RiAddLine,
  RiAlertLine,
  RiArrowRightSLine,
  RiQuestionLine,
  RiRobot2Line,
} from '@remixicon/react';
import type { Agent } from '@alaborderie/plugin-cloud-agents-common';
import { rootRouteRef } from '../../routes';
import {
  ago,
  dayGroup,
  elapsed,
  plural,
  prNumber,
  repoName,
} from '../../format';
import {
  tierOf,
  useAgentsSource,
  useNotify,
  useNow,
  useTiers,
} from '../../hooks';
import { ActivityLine } from '../list/ActivityLine';
import {
  CelebrationLayer,
  StateMessage,
  StatusPill,
  tierIcon,
  ui,
  useCelebrate,
} from '../ui';
import styles from './Widget.module.css';

const ORDER: Partial<Record<Agent['status'], number>> = {
  needs_input: 0,
  running: 1,
  queued: 2,
};

function WidgetRow(props: {
  agent: Agent;
  base: string;
  index: number;
  now: number;
}) {
  const { agent, base, now } = props;
  const tier = tierOf(useTiers(), agent);
  const needs = agent.status === 'needs_input';
  const Glyph = needs ? RiQuestionLine : tierIcon(tier?.name);
  const TierIcon = tierIcon(tier?.name);
  const run = agent.runs[agent.runs.length - 1];
  const href = `${base}/agents/${agent.id}`;
  return (
    <div
      className={`${styles.agent} ${ui.enter}`}
      data-needs={needs ? '' : undefined}
      style={{ '--i': props.index } as React.CSSProperties}
    >
      <span className={styles.glyph}>
        <Glyph className={ui.icon} aria-hidden="true" />
      </span>
      <div className={styles.main}>
        <Link className={styles.title} to={href}>
          {agent.title}
        </Link>
        <div className={ui.meta}>
          <span>{repoName(agent.repo)}</span>
          <span className={ui.tier}>
            <TierIcon className={ui.iconXs} aria-hidden="true" />
            {tier?.name ?? agent.harness}
          </span>
          {needs && <span>asked {ago(agent.updatedAt, now)}</span>}
        </div>
        {needs && agent.openQuestions[0] && (
          <p className={styles.question}>{agent.openQuestions[0].question}</p>
        )}
        {agent.status === 'running' && agent.activity && (
          <ActivityLine activity={agent.activity} />
        )}
      </div>
      <div className={styles.side}>
        <StatusPill status={agent.status} />
        {agent.status === 'running' && run && (
          <span className={ui.elapsed} role="timer" aria-label="Elapsed">
            {elapsed(now - Date.parse(run.startedAt))}
          </span>
        )}
        {needs && (
          <ButtonLink
            href={href}
            variant="primary"
            size="small"
            aria-label={`Answer ${agent.title}`}
          >
            Answer
          </ButtonLink>
        )}
      </div>
    </div>
  );
}

function Body(props: { base: string }) {
  const { base } = props;
  const agents = useAgentsSource();
  const now = useNow();
  const notify = useNotify();
  const celebrate = useCelebrate();
  const footRef = useRef<HTMLDivElement>(null);
  const previous = useRef<Map<string, Agent['status']>>();

  useEffect(() => {
    if (!agents.value) return;
    const before = previous.current;
    previous.current = new Map(agents.value.map(a => [a.id, a.status]));
    if (!before) return;
    for (const agent of agents.value) {
      if (agent.status === 'succeeded' && before.get(agent.id) === 'running') {
        celebrate(footRef.current);
        notify({
          title: 'Agent finished',
          description: agent.prUrl
            ? `Opened ${repoName(agent.repo)} #${prNumber(agent.prUrl)}.`
            : agent.title,
          status: 'success',
          ...(agent.prUrl && { link: { label: 'View PR', href: agent.prUrl } }),
        });
      }
    }
  }, [agents.value, celebrate, notify]);

  if (!agents.value && agents.loading) {
    return (
      <div aria-busy="true" aria-label="Loading agents">
        {[0, 1, 2].map(i => (
          <div key={i} className={styles.skelRow}>
            <Skeleton width={32} height={32} />
            <div style={{ flex: 1 }}>
              <Skeleton width={`${64 - i * 12}%`} height={13} />
              <Skeleton width="36%" height={10} style={{ marginTop: 8 }} />
            </div>
          </div>
        ))}
      </div>
    );
  }
  if (!agents.value && agents.error) {
    return (
      <StateMessage
        icon={RiAlertLine}
        tone="error"
        role="alert"
        title="Agents are unreachable"
        className={styles.state}
        action={
          <Button variant="secondary" size="small" onPress={agents.reload}>
            Try again
          </Button>
        }
      >
        {agents.error.message}
      </StateMessage>
    );
  }

  const all = agents.value ?? [];
  const active = all
    .filter(a => ORDER[a.status] !== undefined)
    .sort((a, b) => (ORDER[a.status] ?? 9) - (ORDER[b.status] ?? 9));
  const today = all.filter(
    a =>
      (a.status === 'succeeded' || a.status === 'failed') &&
      dayGroup(a.updatedAt, now) === 'Today',
  );
  const prs = today.filter(a => a.prUrl).length;

  return (
    <div className={styles.body} aria-live="polite">
      {active.length ? (
        active.map((agent, i) => (
          <WidgetRow
            key={agent.id}
            agent={agent}
            base={base}
            index={i}
            now={now}
          />
        ))
      ) : (
        <StateMessage
          icon={RiRobot2Line}
          title="No agents running"
          className={styles.state}
          action={
            <ButtonLink
              href={`${base}/new`}
              variant="primary"
              size="small"
              iconStart={<RiAddLine aria-hidden="true" />}
            >
              New agent
            </ButtonLink>
          }
        >
          Hand an issue to an agent, or start one from a prompt.
        </StateMessage>
      )}
      <div className={styles.foot} ref={footRef}>
        <span>
          {plural(today.length, 'agent')} finished today ·{' '}
          {plural(prs, 'pull request')} opened
        </span>
        <span className={styles.links}>
          <Link to={base}>
            All agents
            <RiArrowRightSLine className={ui.iconXs} aria-hidden="true" />
          </Link>
          <Link to={`${base}/new`}>
            <RiAddLine className={ui.iconXs} aria-hidden="true" />
            New agent
          </Link>
        </span>
      </div>
    </div>
  );
}

/**
 * The home page widget: agents that need you, running and queued agents, and
 * what finished today.
 */
export function CloudAgentsWidget() {
  const base = useRouteRef(rootRouteRef)?.() ?? '/cloud-agents';
  return (
    <CelebrationLayer>
      <div className={`${ui.scope} ${styles.root}`}>
        <Body base={base} />
      </div>
    </CelebrationLayer>
  );
}
