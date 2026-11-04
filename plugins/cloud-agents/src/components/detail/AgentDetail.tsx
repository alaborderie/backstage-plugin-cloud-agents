import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { Link, useLocation, useParams } from 'react-router-dom';
import { Dialog, Heading } from 'react-aria-components';
import {
  Button,
  ButtonLink,
  DialogTrigger,
  Popover,
  Skeleton,
} from '@backstage/ui';
import { useApi } from '@backstage/frontend-plugin-api';
import {
  RiAlertLine,
  RiArrowDownLine,
  RiArrowLeftLine,
  RiFileCopyLine,
  RiGitBranchLine,
  RiGitPullRequestLine,
  RiGithubLine,
  RiRefreshLine,
  RiStopLine,
} from '@remixicon/react';
import type {
  Agent,
  AgentEventEnvelope,
  OpenQuestion,
} from '@alaborderie/plugin-cloud-agents-common';
import { CloudAgentsApiError, cloudAgentsApiRef } from '../../api';
import {
  STATUS_LABEL,
  ago,
  duration,
  elapsed,
  plural,
  prNumber,
} from '../../format';
import {
  tierOf,
  useAgent,
  useAgentEvents,
  useAgents,
  useBasePath,
  useNotify,
  useNow,
  usePrefersReducedMotion,
  useTiers,
} from '../../hooks';
import {
  StateMessage,
  StatusPill,
  tierIcon,
  ui,
  useCelebrate,
  useFocusWhen,
} from '../ui';
import { Composer } from './Composer';
import { Rail } from './Rail';
import { TimelineItem, type TimelineContext } from './Timeline';
import { buildTimeline, questionEvents } from './timeline';
import styles from './Detail.module.css';

const REFRESH_ON = new Set([
  'agent.status',
  'agent.run_started',
  'question',
  'run.finished',
]);

/** Within this distance of the bottom, new events keep the page following. */
const FOLLOW_SLACK_PX = 260;

/** Agents celebrated in this page session, so a success bursts only once. */
const celebrated = new Set<string>();

function scrollParent(element: HTMLElement | null): HTMLElement {
  for (let el = element?.parentElement; el; el = el.parentElement) {
    const { overflowY } = getComputedStyle(el);
    if (/(auto|scroll)/.test(overflowY) && el.scrollHeight > el.clientHeight) {
      return el;
    }
  }
  return (document.scrollingElement as HTMLElement) ?? document.documentElement;
}

function nearBottom(scroller: HTMLElement): boolean {
  return (
    scroller.scrollTop + scroller.clientHeight >=
    scroller.scrollHeight - FOLLOW_SLACK_PX
  );
}

/** The Stop confirmation. "Keep running" takes focus, the safe choice. */
function StopConfirm(props: {
  branch: string;
  stopping: boolean;
  close(): void;
  onStop(): void;
}) {
  const ref = useFocusWhen<HTMLDivElement>(true);
  return (
    <>
      <Heading slot="title" className={styles.popoverTitle}>
        Stop this agent?
      </Heading>
      <p>
        The Job is deleted and the run reports{' '}
        <span className={ui.mono}>cancelled</span>. Commits the agent already
        pushed stay on <span className={ui.mono}>{props.branch}</span>.
      </p>
      <div ref={ref} className={styles.popoverActions}>
        <Button variant="tertiary" size="small" onPress={props.close}>
          Keep running
        </Button>
        <Button
          variant="primary"
          size="small"
          isPending={props.stopping}
          onPress={props.onStop}
        >
          Stop agent
        </Button>
      </div>
    </>
  );
}

function StopButton(props: { agent: Agent; onStopped(): void }) {
  const api = useApi(cloudAgentsApiRef);
  const notify = useNotify();
  const [stopping, setStopping] = useState(false);
  const stop = async (close: () => void) => {
    setStopping(true);
    try {
      await api.stop(props.agent.id);
      notify({
        title: 'Agent stopped',
        description:
          'The Job was deleted. Follow up to resume on the same branch.',
        status: 'info',
      });
      close();
      props.onStopped();
    } catch (e) {
      notify({
        title: 'Could not stop the agent',
        description: (e as Error).message,
        status: 'danger',
      });
    } finally {
      setStopping(false);
    }
  };
  return (
    <DialogTrigger>
      <Button
        variant="secondary"
        destructive
        iconStart={<RiStopLine aria-hidden="true" />}
      >
        Stop
      </Button>
      <Popover placement="bottom end" hideArrow className={styles.popover}>
        <Dialog className={styles.popoverDialog} aria-label="Stop this agent?">
          {({ close }) => (
            <StopConfirm
              branch={props.agent.branch}
              stopping={stopping}
              close={close}
              onStop={() => stop(close)}
            />
          )}
        </Dialog>
      </Popover>
    </DialogTrigger>
  );
}

function Header(props: { agent: Agent; onStopped(): void }) {
  const { agent } = props;
  const base = useBasePath();
  const now = useNow();
  const notify = useNotify();
  const tier = tierOf(useTiers(), agent);
  const TierIcon = tierIcon(tier?.name);
  const active = agent.status === 'queued' || agent.status === 'running';
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(agent.branch);
      notify({ title: 'Copied', description: agent.branch, status: 'info' });
    } catch {
      notify({
        title: 'Could not copy',
        description: 'The browser blocked the clipboard.',
        status: 'warning',
      });
    }
  };
  const jump = (runId: string) => {
    document.getElementById(`run-${runId}`)?.scrollIntoView({
      block: 'center',
      behavior: window.matchMedia?.('(prefers-reduced-motion: reduce)').matches
        ? 'auto'
        : 'smooth',
    });
  };
  return (
    <>
      <Link className={styles.crumb} to={base}>
        <RiArrowLeftLine className={ui.icon} aria-hidden="true" />
        Agents
      </Link>
      <div className={styles.dHead}>
        <div className={styles.titles}>
          <StatusPill status={agent.status} large />
          <h2 id="agent-title">{agent.title}</h2>
          <div className={ui.meta}>
            <span>
              <RiGithubLine className={ui.iconXs} aria-hidden="true" />
              {agent.repo}
            </span>
            <button
              type="button"
              className={styles.copy}
              onClick={copy}
              aria-label={`Copy branch name ${agent.branch}`}
            >
              <RiGitBranchLine className={ui.iconXs} aria-hidden="true" />
              {agent.branch}
              <RiFileCopyLine className={ui.iconXs} aria-hidden="true" />
            </button>
            <span>from {agent.base}</span>
            <span className={ui.tier}>
              <TierIcon className={ui.iconXs} aria-hidden="true" />
              {tier ? `${tier.name} · ${agent.harness}` : agent.harness}
            </span>
            <span>started {ago(agent.createdAt, now)}</span>
          </div>
        </div>
        <div className={styles.dActions}>
          {agent.prUrl && (
            <ButtonLink
              href={agent.prUrl}
              target="_blank"
              rel="noopener noreferrer"
              variant="secondary"
              iconStart={<RiGitPullRequestLine aria-hidden="true" />}
            >
              PR #{prNumber(agent.prUrl)}
            </ButtonLink>
          )}
          {active && <StopButton agent={agent} onStopped={props.onStopped} />}
        </div>
      </div>
      <nav className={styles.runs} aria-label="Runs">
        {agent.runs.length ? (
          agent.runs.map((run, i) => (
            <a
              key={run.id}
              className={styles.runChip}
              href={`#run-${run.id}`}
              onClick={event => {
                event.preventDefault();
                jump(run.id);
              }}
            >
              <span className={styles.runDot} data-status={run.status} />
              <b>Run {i + 1}</b>
              {STATUS_LABEL[run.status]}
              {run.finishedAt
                ? ` · ${duration(
                    Date.parse(run.finishedAt) - Date.parse(run.startedAt),
                  )}`
                : run.status === 'running' && (
                    <span className={ui.elapsed}>
                      {' '}
                      · {elapsed(now - Date.parse(run.startedAt))}
                    </span>
                  )}
            </a>
          ))
        ) : (
          <span className={ui.meta}>Waiting for a Kubernetes Job.</span>
        )}
      </nav>
    </>
  );
}

function DetailSkeleton() {
  return (
    <div aria-busy="true" aria-label="Loading the agent">
      <Skeleton width={70} height={14} />
      <Skeleton width={90} height={26} rounded style={{ marginTop: 18 }} />
      <Skeleton width="48%" height={26} style={{ marginTop: 10 }} />
      <Skeleton width="62%" height={12} style={{ marginTop: 10 }} />
      <div className={styles.detail} style={{ marginTop: 32 }}>
        <div>
          {Array.from({ length: 6 }, (_, i) => (
            <div key={i} className={styles.skelRow}>
              <Skeleton width={32} height={32} />
              <Skeleton width={`${70 - (i % 3) * 15}%`} height={13} />
            </div>
          ))}
        </div>
        <div className={styles.rail}>
          <Skeleton height={120} />
          <Skeleton height={160} />
        </div>
      </div>
    </div>
  );
}

function Loaded(props: { agent: Agent; reload(): void }) {
  const { agent, reload } = props;
  const location = useLocation();
  const notify = useNotify();
  const celebrate = useCelebrate();
  const reduced = usePrefersReducedMotion();
  const tier = tierOf(useTiers(), agent);
  const list = useAgents();
  const [answers, setAnswers] = useState<ReadonlyMap<string, string>>(
    new Map(),
  );
  const [unseen, setUnseen] = useState(0);
  const logRef = useRef<HTMLOListElement>(null);
  const composerRef = useRef<HTMLDivElement>(null);
  const prCardRef = useRef<HTMLDivElement>(null);
  const following = useRef(true);
  const seenCount = useRef(0);

  const onEvent = useCallback(
    (envelope: AgentEventEnvelope) => {
      if (REFRESH_ON.has(envelope.event.type)) {
        reload();
        list.reload();
      }
    },
    [reload, list],
  );
  const stream = useAgentEvents(agent.id, onEvent);
  const timeline = useMemo(() => buildTimeline(stream.events), [stream.events]);
  const questions = useMemo(
    () => questionEvents(stream.events),
    [stream.events],
  );
  const pick = Number(new URLSearchParams(location.search).get('pick'));
  const initialPick =
    new URLSearchParams(location.search).has('pick') && Number.isInteger(pick)
      ? pick
      : undefined;

  const scrollToEnd = useCallback(() => {
    composerRef.current?.scrollIntoView({
      block: 'end',
      behavior: reduced ? 'auto' : 'smooth',
    });
  }, [reduced]);

  useEffect(() => {
    const scroller = scrollParent(logRef.current);
    const target: HTMLElement | Window =
      scroller === document.scrollingElement ? window : scroller;
    const onScroll = () => {
      following.current = nearBottom(scroller);
      if (following.current) setUnseen(0);
    };
    onScroll();
    target.addEventListener('scroll', onScroll, { passive: true });
    return () => target.removeEventListener('scroll', onScroll);
  }, []);

  const liveItems = timeline.items.filter(
    item => item.seq > stream.historySeq,
  ).length;
  useLayoutEffect(() => {
    const added = liveItems - seenCount.current;
    seenCount.current = liveItems;
    if (added <= 0) return;
    if (following.current) scrollToEnd();
    else setUnseen(n => n + added);
  }, [liveItems, scrollToEnd]);

  useEffect(() => {
    const finished = [...stream.events]
      .reverse()
      .find(
        env =>
          env.seq > stream.historySeq &&
          env.event.type === 'run.finished' &&
          env.event.status === 'succeeded',
      );
    if (!finished || celebrated.has(agent.id)) return;
    celebrated.add(agent.id);
    const card = logRef.current?.querySelector(
      `[data-finish-seq="${finished.seq}"]`,
    );
    celebrate(card);
    setTimeout(() => celebrate(prCardRef.current), 160);
    const prUrl =
      finished.event.type === 'run.finished' ? finished.event.pr_url : null;
    notify({
      title: 'Agent succeeded',
      description: prUrl
        ? `Pushed to pull request #${prNumber(prUrl)}.`
        : `Pushed to ${agent.branch}.`,
      status: 'success',
      ...(prUrl && { link: { label: 'View PR', href: prUrl } }),
    });
  }, [
    stream.events,
    stream.historySeq,
    agent.id,
    agent.branch,
    celebrate,
    notify,
  ]);

  const restarted = () => {
    reload();
    list.reload();
    stream.restart();
  };
  const onAnswered = (question: OpenQuestion, answer: string) =>
    setAnswers(prev =>
      new Map(prev).set(`${question.runId}:${question.questionId}`, answer),
    );

  const ctx: TimelineContext = {
    agent,
    tier,
    historySeq: stream.historySeq,
    answers,
  };
  const asking = agent.status === 'needs_input';

  return (
    <section aria-labelledby="agent-title">
      <Header agent={agent} onStopped={restarted} />
      <div className={styles.detail}>
        <div className={styles.tlWrap} data-asking={asking ? '' : undefined}>
          {stream.error && (
            <div className={styles.reconnecting} role="status">
              <span className={ui.spinner} aria-hidden="true" />
              Reconnecting to the event stream: {stream.error.message}
            </div>
          )}
          <ol
            ref={logRef}
            className={styles.tl}
            role="log"
            aria-label="Agent events"
            aria-live="polite"
            aria-relevant="additions"
          >
            {timeline.items.map(item => (
              <TimelineItem key={item.key} item={item} ctx={ctx} />
            ))}
          </ol>
          {!timeline.items.length && (
            <div className={styles.waiting}>
              <StateMessage icon={RiRefreshLine} title="Waiting for the runner">
                Events appear here as soon as the Job&apos;s pod starts.
              </StateMessage>
            </div>
          )}
          {unseen > 0 && (
            <div className={styles.jump}>
              <button
                type="button"
                onClick={() => {
                  setUnseen(0);
                  scrollToEnd();
                }}
              >
                <RiArrowDownLine className={ui.icon} aria-hidden="true" />
                {plural(unseen, 'new event')}
              </button>
            </div>
          )}
          <div ref={composerRef} className={styles.composerHost}>
            <Composer
              agent={agent}
              questionEvents={questions}
              initialPick={initialPick}
              onAnswered={onAnswered}
              onRestarted={restarted}
            />
          </div>
        </div>
        <Rail agent={agent} timeline={timeline} prCardRef={prCardRef} />
      </div>
    </section>
  );
}

export function AgentDetail() {
  const { id = '' } = useParams();
  const base = useBasePath();
  const agent = useAgent(id);

  if (!agent.value && agent.error) {
    const notFound =
      agent.error instanceof CloudAgentsApiError && agent.error.status === 404;
    return (
      <StateMessage
        icon={RiAlertLine}
        tone="error"
        role="alert"
        title={notFound ? 'Agent not found' : 'Could not load the agent'}
        action={
          notFound ? (
            <ButtonLink href={base} variant="secondary">
              Back to agents
            </ButtonLink>
          ) : (
            <Button variant="secondary" onPress={agent.reload}>
              Try again
            </Button>
          )
        }
      >
        {notFound ? (
          <>
            No agent <code>{id}</code> is visible to you. Agents are private to
            the user who started them.
          </>
        ) : (
          agent.error.message
        )}
      </StateMessage>
    );
  }
  if (!agent.value) return <DetailSkeleton />;
  return <Loaded key={id} agent={agent.value} reload={agent.reload} />;
}
