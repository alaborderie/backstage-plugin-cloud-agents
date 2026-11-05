import { useEffect, useMemo, useRef, useState, type Key } from 'react';
import { Link } from 'react-router-dom';
import {
  Button,
  ButtonLink,
  SearchField,
  Skeleton,
  ToggleButton,
  ToggleButtonGroup,
} from '@backstage/ui';
import {
  RiAddLine,
  RiAlertLine,
  RiExternalLinkLine,
  RiGitPullRequestLine,
  RiRefreshLine,
  RiRobot2Line,
  RiSearchLine,
} from '@remixicon/react';
import type { Agent, TierInfo } from '@alaborderie/plugin-cloud-agents-common';
import {
  ago,
  dayGroup,
  duration,
  elapsed,
  isTyping,
  prNumber,
  repoName,
} from '../../format';
import { tierOf, useAgents, useBasePath, useNow, useTiers } from '../../hooks';
import {
  Kbd,
  STATUS_GLYPH,
  StateMessage,
  StatusPill,
  tierIcon,
  ui,
} from '../ui';
import { ActivityLine } from './ActivityLine';
import styles from './List.module.css';

interface Filter {
  id: string;
  label: string;
  test(agent: Agent): boolean;
}

const FILTERS: readonly Filter[] = [
  { id: 'all', label: 'All', test: () => true },
  { id: 'needs', label: 'Needs you', test: a => a.status === 'needs_input' },
  {
    id: 'active',
    label: 'Running',
    test: a => a.status === 'running' || a.status === 'queued',
  },
  { id: 'succeeded', label: 'Succeeded', test: a => a.status === 'succeeded' },
  { id: 'failed', label: 'Failed', test: a => a.status === 'failed' },
  { id: 'stopped', label: 'Stopped', test: a => a.status === 'stopped' },
];

const isActive = (a: Agent) => a.status === 'running' || a.status === 'queued';

function matches(agent: Agent, query: string): boolean {
  const q = query.trim().toLowerCase();
  return (
    !q ||
    `${agent.title} ${agent.repo} ${agent.branch}`.toLowerCase().includes(q)
  );
}

function TierLabel(props: { tier: TierInfo | undefined; harness: string }) {
  const Icon = tierIcon(props.tier?.name);
  return (
    <span className={ui.tier}>
      <Icon className={ui.iconXs} aria-hidden="true" />
      {props.tier?.name ?? props.harness}
    </span>
  );
}

function PrChip(props: { url: string }) {
  return (
    <a
      className={styles.prLink}
      href={props.url}
      target="_blank"
      rel="noopener noreferrer"
      aria-label={`Pull request #${prNumber(props.url)}`}
    >
      <RiGitPullRequestLine className={ui.iconXs} aria-hidden="true" />#
      {prNumber(props.url)}
      <RiExternalLinkLine className={ui.iconXs} aria-hidden="true" />
    </a>
  );
}

function AgentRow(props: {
  agent: Agent;
  index: number;
  now: number;
  selected: boolean;
}) {
  const { agent, now } = props;
  const base = useBasePath();
  const tier = tierOf(useTiers(), agent);
  const Glyph = STATUS_GLYPH[agent.status] ?? tierIcon(tier?.name);
  const lastRun = agent.runs[agent.runs.length - 1];
  const firstRun = agent.runs[0];
  const running = agent.status === 'running';
  return (
    <div
      className={`${styles.row} ${ui.enter}`}
      style={{ '--i': props.index } as React.CSSProperties}
      data-row={agent.id}
      data-selected={props.selected ? '' : undefined}
    >
      <span className={styles.glyph} data-status={agent.status}>
        <Glyph className={ui.icon} aria-hidden="true" />
      </span>
      <div className={styles.rowMain}>
        <Link className={styles.rowTitle} to={`${base}/agents/${agent.id}`}>
          {agent.title}
        </Link>
        <div className={ui.meta}>
          <span>{repoName(agent.repo)}</span>
          <span className={ui.mono}>{agent.branch}</span>
          <TierLabel tier={tier} harness={agent.harness} />
          {agent.runs.length > 1 && <span>{agent.runs.length} runs</span>}
        </div>
        {running && agent.activity && (
          <ActivityLine activity={agent.activity} />
        )}
      </div>
      <div className={styles.rowSide}>
        {agent.prUrl && <PrChip url={agent.prUrl} />}
        {running && lastRun ? (
          <span className={ui.elapsed} role="timer" aria-label="Elapsed">
            {elapsed(now - Date.parse(lastRun.startedAt))}
          </span>
        ) : (
          lastRun?.finishedAt &&
          firstRun && (
            <span>
              {duration(
                Date.parse(lastRun.finishedAt) - Date.parse(firstRun.startedAt),
              )}
            </span>
          )
        )}
        <span>{ago(agent.updatedAt, now)}</span>
        <StatusPill status={agent.status} />
      </div>
      {running && <span className={ui.progress} aria-hidden="true" />}
    </div>
  );
}

function NeedsYouCard(props: { agent: Agent; index: number; now: number }) {
  const { agent } = props;
  const base = useBasePath();
  const tier = tierOf(useTiers(), agent);
  const [question, ...more] = agent.openQuestions;
  return (
    <article
      className={`${styles.needsCard} ${ui.enter}`}
      style={{ '--i': props.index } as React.CSSProperties}
      data-row={agent.id}
    >
      <div className={styles.needsTop}>
        <StatusPill status="needs_input" />
        <span className={ui.meta}>
          <span>{repoName(agent.repo)}</span>
          <TierLabel tier={tier} harness={agent.harness} />
          <span>asked {ago(agent.updatedAt, props.now)}</span>
        </span>
      </div>
      <h3>
        <Link to={`${base}/agents/${agent.id}`}>{agent.title}</Link>
      </h3>
      {question && (
        <>
          <blockquote>{question.question}</blockquote>
          <div className={styles.opts}>
            {question.options.map((option, k) => (
              <Link
                key={option}
                className={ui.chip}
                to={`${base}/agents/${agent.id}?pick=${k}`}
              >
                {option}
              </Link>
            ))}
            {more.length > 0 && (
              <span className={ui.meta}>
                +{more.length} more question{more.length > 1 ? 's' : ''}
              </span>
            )}
          </div>
        </>
      )}
    </article>
  );
}

function LoadingRows() {
  return (
    <div aria-busy="true" aria-label="Loading agents">
      {Array.from({ length: 6 }, (_, i) => (
        <div
          key={i}
          className={styles.row}
          style={{ opacity: 1 - i * 0.13 }}
          aria-hidden="true"
        >
          <Skeleton width={32} height={32} />
          <div>
            <Skeleton width={`${62 - (i % 3) * 12}%`} height={13} />
            <Skeleton width="38%" height={10} style={{ marginTop: 8 }} />
          </div>
          <Skeleton width={80} height={22} rounded />
        </div>
      ))}
    </div>
  );
}

const SECTIONS = ['Today', 'Yesterday', 'Earlier'] as const;

export function AgentsList() {
  const agents = useAgents();
  const base = useBasePath();
  const now = useNow();
  const [filter, setFilter] = useState('all');
  const [query, setQuery] = useState('');
  const [selected, setSelected] = useState(-1);
  const listRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLDivElement>(null);

  const all = useMemo(() => agents.value ?? [], [agents.value]);
  const active = FILTERS.find(f => f.id === filter) ?? FILTERS[0]!;
  const shown = all.filter(a => active.test(a) && matches(a, query));
  const needs = shown.filter(a => a.status === 'needs_input');
  const inProgress = shown.filter(isActive);
  const done = shown.filter(a => a.status !== 'needs_input' && !isActive(a));

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.metaKey || event.ctrlKey || event.altKey) return;
      if (isTyping(event.target)) return;
      if (event.key === '/') {
        event.preventDefault();
        searchRef.current?.querySelector('input')?.focus();
        return;
      }
      if (event.key !== 'j' && event.key !== 'k') return;
      const rows = [
        ...(listRef.current?.querySelectorAll<HTMLElement>('[data-row]') ?? []),
      ];
      if (!rows.length) return;
      event.preventDefault();
      setSelected(current => {
        const next = Math.max(
          0,
          Math.min(rows.length - 1, current + (event.key === 'j' ? 1 : -1)),
        );
        rows[next]?.querySelector<HTMLElement>('a')?.focus();
        return next;
      });
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, []);

  const clear = () => {
    setFilter('all');
    setQuery('');
  };

  let body: React.ReactNode;
  if (!agents.value && agents.loading) {
    body = <LoadingRows />;
  } else if (!agents.value && agents.error) {
    body = (
      <StateMessage
        icon={RiAlertLine}
        tone="error"
        role="alert"
        title="Could not load your agents"
        action={
          <Button
            variant="secondary"
            iconStart={<RiRefreshLine aria-hidden="true" />}
            onPress={agents.reload}
          >
            Try again
          </Button>
        }
      >
        {agents.error.message}. The list retries every 5 seconds.
      </StateMessage>
    );
  } else if (!all.length) {
    body = (
      <StateMessage
        icon={RiRobot2Line}
        title="No agents yet"
        action={
          <ButtonLink
            href={`${base}/new`}
            variant="primary"
            iconStart={<RiAddLine aria-hidden="true" />}
          >
            Start your first agent
          </ButtonLink>
        }
      >
        Describe a change, pick a repository and a tier. The agent works on its
        own branch and opens a pull request.
      </StateMessage>
    );
  } else if (!shown.length) {
    body = (
      <StateMessage
        icon={RiSearchLine}
        title="No agents match"
        action={
          <Button variant="secondary" onPress={clear}>
            Clear filters
          </Button>
        }
      >
        {query.trim()
          ? `Nothing matches “${query.trim()}”.`
          : `No agent is ${active.label.toLowerCase()} right now.`}
      </StateMessage>
    );
  } else {
    let index = 0;
    const row = (agent: Agent) => {
      const i = index++;
      return (
        <AgentRow
          key={agent.id}
          agent={agent}
          index={i}
          now={now}
          selected={i === selected}
        />
      );
    };
    body = (
      <>
        {needs.length > 0 && (
          <section aria-labelledby="ca-needs">
            <h2 id="ca-needs" className={ui.sectionH}>
              Needs you
            </h2>
            <div className={styles.needsGrid}>
              {needs.map(agent => (
                <NeedsYouCard
                  key={agent.id}
                  agent={agent}
                  index={index++}
                  now={now}
                />
              ))}
            </div>
          </section>
        )}
        {inProgress.length > 0 && (
          <section aria-labelledby="ca-progress">
            <h2 id="ca-progress" className={ui.sectionH}>
              In progress
            </h2>
            <div className={styles.rows}>{inProgress.map(row)}</div>
          </section>
        )}
        {SECTIONS.map(day => {
          const group = done.filter(a => dayGroup(a.updatedAt, now) === day);
          return (
            group.length > 0 && (
              <section key={day} aria-labelledby={`ca-${day}`}>
                <h2 id={`ca-${day}`} className={ui.sectionH}>
                  {day}
                </h2>
                <div className={styles.rows}>{group.map(row)}</div>
              </section>
            )
          );
        })}
        <div className={styles.hints} aria-hidden="true">
          <span>
            <Kbd>J</Kbd> <Kbd>K</Kbd> move
          </span>
          <span>
            <Kbd>↵</Kbd> open
          </span>
          <span>
            <Kbd>N</Kbd> new agent
          </span>
          <span>
            <Kbd>/</Kbd> search
          </span>
        </div>
      </>
    );
  }

  return (
    <section aria-label="Agents">
      <div className={styles.tools}>
        <div ref={searchRef} className={styles.search}>
          <SearchField
            aria-label="Search agents"
            placeholder="Search agents, repositories, branches"
            value={query}
            onChange={setQuery}
          />
          <span className={styles.searchKbd}>
            <Kbd>/</Kbd>
          </span>
        </div>
        <ToggleButtonGroup
          aria-label="Filter by status"
          selectionMode="single"
          disallowEmptySelection
          selectedKeys={[filter]}
          onSelectionChange={(keys: Set<Key>) => {
            const [key] = [...keys];
            if (key !== undefined) setFilter(String(key));
          }}
          className={styles.filters}
        >
          {FILTERS.map(f => (
            <ToggleButton key={f.id} id={f.id} size="small">
              {f.label}
              {agents.value && ' '}
              {agents.value && (
                <span className={styles.count}>
                  {all.filter(f.test).length}
                </span>
              )}
            </ToggleButton>
          ))}
        </ToggleButtonGroup>
      </div>
      <div ref={listRef} className={styles.listBody} aria-live="polite">
        {body}
      </div>
    </section>
  );
}
