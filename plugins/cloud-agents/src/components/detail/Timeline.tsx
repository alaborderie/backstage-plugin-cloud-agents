import { useId, useState, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import {
  RiAlertLine,
  RiArrowRightSLine,
  RiBox3Line,
  RiCheckboxCircleLine,
  RiCheckLine,
  RiCloseCircleLine,
  RiCloseLine,
  RiDashboard3Line,
  RiExternalLinkLine,
  RiFlowChart,
  RiGitBranchLine,
  RiGitPullRequestLine,
  RiInformationLine,
  RiNodeTree,
  RiQuestionLine,
  RiSearchLine,
  RiStopCircleLine,
  RiUserLine,
} from '@remixicon/react';
import { ButtonLink } from '@backstage/ui';
import type { Agent, TierInfo } from '@alaborderie/plugin-cloud-agents-common';
import { summarizeToolInput } from '@alaborderie/plugin-cloud-agents-common';
import {
  STATUS_LABEL,
  clock,
  duration,
  prNumber,
  shortSha,
} from '../../format';
import { useBasePath } from '../../hooks';
import { KIND_ICON, tierIcon, ui, type Icon } from '../ui';
import type { Item, SetupItem, ToolCall } from './timeline';
import styles from './Detail.module.css';

export interface TimelineContext {
  agent: Agent;
  tier: TierInfo | undefined;
  /** Items created after the replay slide in. */
  historySeq: number;
  /** Answers sent from this page, by `<runId>:<questionId>`. */
  answers: ReadonlyMap<string, string>;
}

type Dot = 'agent' | 'ok' | 'err' | 'warn' | 'attn' | undefined;

function Row(props: {
  item: Item;
  ctx: TimelineContext;
  icon: Icon;
  dot?: Dot;
  children: ReactNode;
  compact?: boolean;
}) {
  const IconComponent = props.icon;
  return (
    <li
      className={`${styles.ev} ${
        props.item.seq > props.ctx.historySeq ? styles.evNew : ''
      }`}
      data-seq={props.item.seq}
    >
      <span className={styles.evDot} data-tone={props.dot}>
        <IconComponent className={ui.icon} aria-hidden="true" />
      </span>
      <div
        className={`${styles.evBody} ${
          props.compact ? styles.evBodyCompact : ''
        }`}
      >
        {props.children}
      </div>
    </li>
  );
}

function Time(props: { ts: string }) {
  return (
    <time className={styles.evTime} dateTime={props.ts}>
      {clock(props.ts)}
    </time>
  );
}

/** Inline `code` spans in agent prose. Events arrive whole, so no typewriter. */
function Prose(props: { text: string; className?: string }) {
  const parts = props.text.split('`');
  return (
    <div className={props.className}>
      {parts.map((part, i) =>
        i % 2 === 1 && i < parts.length - 1 ? (
          <code key={i}>{part}</code>
        ) : (
          <span key={i}>{i % 2 === 1 ? `\`${part}` : part}</span>
        ),
      )}
    </div>
  );
}

/** A row that expands to show more, such as a tool's output. */
function Disclosure(props: {
  label: ReactNode;
  arg?: ReactNode;
  status?: ReactNode;
  defaultOpen?: boolean;
  children: ReactNode;
}) {
  const [open, setOpen] = useState<boolean | undefined>(undefined);
  const expanded = open ?? props.defaultOpen ?? false;
  const id = useId();
  return (
    <>
      <button
        type="button"
        className={styles.tool}
        aria-expanded={expanded}
        aria-controls={id}
        onClick={() => setOpen(!expanded)}
      >
        <span className={styles.toolName}>{props.label}</span>
        {props.arg && <span className={styles.toolArg}>{props.arg}</span>}
        <span className={styles.toolStatus}>{props.status}</span>
        <RiArrowRightSLine
          className={`${ui.iconXs} ${styles.chev}`}
          aria-hidden="true"
        />
      </button>
      <div id={id} hidden={!expanded}>
        {expanded && props.children}
      </div>
    </>
  );
}

function ToolStatus(props: { tool: ToolCall }) {
  const { call, result } = props.tool;
  if (!result) {
    return <span className={ui.spinner} role="img" aria-label="Running" />;
  }
  return (
    <>
      {result.is_error ? (
        <span className={styles.failed}>
          <RiCloseLine className={ui.iconXs} aria-hidden="true" />
          failed
        </span>
      ) : (
        <span className={styles.succeeded}>
          <RiCheckLine
            className={ui.iconXs}
            role="img"
            aria-label="Succeeded"
          />
        </span>
      )}
      <span className={styles.dur}>
        {duration(Date.parse(result.ts) - Date.parse(call.ts))}
      </span>
    </>
  );
}

function ToolRow(props: { item: Item; tool: ToolCall; ctx: TimelineContext }) {
  const { call, result } = props.tool;
  return (
    <Row
      item={props.item}
      ctx={props.ctx}
      icon={KIND_ICON[call.kind] ?? RiBox3Line}
      dot={result?.is_error ? 'err' : undefined}
      compact
    >
      <Disclosure
        label={call.name}
        arg={summarizeToolInput(call.input)}
        status={<ToolStatus tool={props.tool} />}
        defaultOpen={result?.is_error}
      >
        <pre
          className={styles.out}
          data-tone={result?.is_error ? 'err' : undefined}
        >
          {result
            ? `${result.output}${result.truncated ? '\n…' : ''}`
            : 'Waiting for output…'}
        </pre>
      </Disclosure>
    </Row>
  );
}

/** A hub woke up because one of its children changed status. */
function WakeRow(props: {
  item: Extract<Item, { kind: 'wake' }>;
  ctx: TimelineContext;
}) {
  const { event } = props.item;
  const base = useBasePath();
  const child = props.ctx.agent.children.find(c => c.id === event.childId);
  return (
    <Row item={props.item} ctx={props.ctx} icon={RiNodeTree} dot="agent">
      <div className={styles.evTitle}>
        <b>Woken by a child</b>
        <span>
          <Link
            className={styles.wakeLink}
            to={`${base}/agents/${event.childId}`}
          >
            {child?.title ?? event.childId}
          </Link>{' '}
          ·{' '}
          {(STATUS_LABEL[event.childStatus] ?? event.childStatus).toLowerCase()}
        </span>
        <Time ts={event.ts} />
      </div>
    </Row>
  );
}

function exploredLabel(tools: ToolCall[]): string {
  const reads = tools.filter(t => t.call.kind === 'read').length;
  const searches = tools.length - reads;
  const parts = [
    reads && `read ${reads} file${reads > 1 ? 's' : ''}`,
    searches && `searched ${searches} pattern${searches > 1 ? 's' : ''}`,
  ].filter(Boolean);
  const label = parts.join(', ');
  return label.charAt(0).toUpperCase() + label.slice(1);
}

function setupSummary(item: SetupItem): string {
  const { started, skills, workspace, session } = item;
  return [
    started && `runner ${started.runner_version}`,
    started &&
      `${started.harness_version ?? started.harness} · ${started.model} (${
        started.effort
      })`,
    skills && `skills ${skills.source}@${shortSha(skills.commit)}`,
    workspace &&
      `workspace ${workspace.branch} at ${shortSha(workspace.head_sha)}${
        workspace.branch_existed
          ? ' (existing branch)'
          : ` (new branch from ${workspace.base})`
      }`,
    session && `session ${session.session_id}`,
  ]
    .filter(Boolean)
    .join('\n');
}

const RUN_REASON: Record<string, string> = {
  initial: 'started from the prompt',
  reply: 'resumed with your answers',
  message: 'started by your follow-up',
  child: 'started by a child event',
};

/** How each `run.finished.status` reads: title, glyph, and tone. */
const FINISH: Record<
  string,
  { title: string; icon: Icon; tone: 'ok' | 'err' | 'attn' | undefined }
> = {
  succeeded: { title: 'Run succeeded', icon: RiCheckboxCircleLine, tone: 'ok' },
  failed: { title: 'Run failed', icon: RiCloseCircleLine, tone: 'err' },
  needs_input: {
    title: 'Run paused for your answers',
    icon: RiQuestionLine,
    tone: 'attn',
  },
  cancelled: {
    title: 'Run cancelled',
    icon: RiStopCircleLine,
    tone: undefined,
  },
};

type Renderers = {
  [K in Item['kind']]: (props: {
    item: Extract<Item, { kind: K }>;
    ctx: TimelineContext;
  }) => ReactNode;
};

/** How each timeline item renders, keyed by kind. */
const RENDER: Renderers = {
  run: ({ item }) => (
    <li className={styles.runDiv} id={`run-${item.runId}`}>
      <span className={styles.evDot} data-tone="agent">
        <RiFlowChart className={ui.icon} aria-hidden="true" />
      </span>
      Run {item.ordinal} · {RUN_REASON[item.reason] ?? item.reason} ·{' '}
      {clock(item.ts)}
    </li>
  ),
  setup: ({ item, ctx }) => {
    const ready = Boolean(item.workspace && item.session);
    return (
      <Row
        item={item}
        ctx={ctx}
        icon={ready ? RiCheckLine : RiBox3Line}
        dot={ready ? 'ok' : undefined}
        compact
      >
        <Disclosure
          label={ready ? 'Workspace ready' : 'Preparing the workspace'}
          arg={[
            item.started?.harness,
            item.workspace && shortSha(item.workspace.head_sha),
            item.workspace?.branch_existed && 'existing branch',
          ]
            .filter(Boolean)
            .join(' · ')}
          status={
            ready ? (
              <Time ts={item.ts} />
            ) : (
              <span className={ui.spinner} role="img" aria-label="Preparing" />
            )
          }
        >
          <pre className={styles.out}>{setupSummary(item)}</pre>
        </Disclosure>
      </Row>
    );
  },
  message: ({ item, ctx }) => (
    <Row item={item} ctx={ctx} icon={tierIcon(ctx.tier?.name)} dot="agent">
      <div className={styles.evTitle}>
        <b>Agent</b>
        <Time ts={item.event.ts} />
      </div>
      <Prose className={styles.prose} text={item.event.text} />
    </Row>
  ),
  you: ({ item, ctx }) => (
    <Row item={item} ctx={ctx} icon={RiUserLine} dot="agent">
      <div className={styles.evTitle}>
        <b>You</b>
        <Time ts={item.event.ts} />
      </div>
      <Prose className={styles.you} text={item.event.text} />
    </Row>
  ),
  wake: ({ item, ctx }) => <WakeRow item={item} ctx={ctx} />,
  tool: ({ item, ctx }) => <ToolRow item={item} tool={item.tool} ctx={ctx} />,
  explored: ({ item, ctx }) => {
    const running = item.tools.some(t => !t.result);
    const failed = item.tools.some(t => t.result?.is_error);
    return (
      <Row
        item={item}
        ctx={ctx}
        icon={RiSearchLine}
        dot={failed ? 'err' : undefined}
        compact
      >
        <Disclosure
          label="Explored"
          arg={
            <span className={styles.sansArg}>{exploredLabel(item.tools)}</span>
          }
          status={
            running ? (
              <span className={ui.spinner} role="img" aria-label="Running" />
            ) : (
              <span className={failed ? styles.failed : styles.succeeded}>
                {failed ? (
                  <RiCloseLine
                    className={ui.iconXs}
                    role="img"
                    aria-label="A call failed"
                  />
                ) : (
                  <RiCheckLine
                    className={ui.iconXs}
                    role="img"
                    aria-label="Succeeded"
                  />
                )}
              </span>
            )
          }
        >
          <ol className={styles.sub}>
            {item.tools.map(tool => (
              <ToolRow
                key={tool.key}
                item={{ kind: 'tool', key: tool.key, seq: 0, tool }}
                tool={tool}
                ctx={ctx}
              />
            ))}
          </ol>
        </Disclosure>
      </Row>
    );
  },
  question: ({ item, ctx }) => {
    const { event } = item;
    const open =
      ctx.agent.status === 'needs_input' &&
      ctx.agent.openQuestions.some(
        q => q.runId === item.runId && q.questionId === event.question_id,
      );
    const answer = ctx.answers.get(`${item.runId}:${event.question_id}`);
    return (
      <Row item={item} ctx={ctx} icon={RiQuestionLine} dot="attn">
        <div className={styles.evTitle}>
          <b>Question</b>
          <span>
            {event.blocking
              ? 'blocking'
              : 'non-blocking, the agent went on with its default'}
          </span>
          <Time ts={event.ts} />
        </div>
        <div
          className={styles.qcard}
          data-open={open && !answer ? '' : undefined}
        >
          <p>{event.question}</p>
          {event.options.length > 0 && (
            <ul>
              {event.options.map(option => (
                <li key={option.label}>
                  {option.label}
                  {option.description && (
                    <span className={styles.optDesc}>
                      {' '}
                      · {option.description}
                    </span>
                  )}
                </li>
              ))}
            </ul>
          )}
          {(answer || (item.answered && event.blocking)) && (
            <div className={styles.answered}>
              <RiCheckLine className={ui.iconXs} aria-hidden="true" />
              {answer ? `You answered: ${answer}` : 'Answered'}
            </div>
          )}
        </div>
      </Row>
    );
  },
  rate_limit: ({ item, ctx }) => {
    const { event } = item;
    return (
      <Row item={item} ctx={ctx} icon={RiDashboard3Line} dot="warn">
        <div className={styles.evTitle}>
          <b>Rate limit {event.status}</b>
          <span>
            {[
              event.window,
              event.utilization !== null &&
                `${Math.round(event.utilization * 100)}% used`,
            ]
              .filter(Boolean)
              .join(' · ')}
          </span>
          <Time ts={event.ts} />
        </div>
        {event.message && (
          <div
            className={
              event.status === 'limited' ? styles.errLine : styles.warnLine
            }
          >
            {event.message}
          </div>
        )}
      </Row>
    );
  },
  log: ({ item, ctx }) => {
    const error = item.event.level === 'error';
    return (
      <Row
        item={item}
        ctx={ctx}
        icon={error ? RiAlertLine : RiInformationLine}
        dot={error ? 'err' : undefined}
      >
        <div className={styles.evTitle}>
          <b>{item.event.source}</b>
          <span
            className={`${ui.mono} ${styles.logLine}`}
            data-level={item.event.level}
          >
            {item.event.message}
          </span>
          <Time ts={item.event.ts} />
        </div>
      </Row>
    );
  },
  finished: ({ item, ctx }) => {
    const { event } = item;
    const usage = event.usage;
    const finish = FINISH[event.status] ?? {
      title: `Run ${event.status}`,
      icon: RiStopCircleLine,
      tone: undefined,
    };
    return (
      <Row item={item} ctx={ctx} icon={finish.icon} dot={finish.tone}>
        <div className={styles.evTitle}>
          <b>{finish.title}</b>
          <span>
            exit {event.exit_code} · {duration(event.duration_ms)}
          </span>
          <Time ts={event.ts} />
        </div>
        <div
          className={styles.finish}
          data-tone={finish.tone === 'attn' ? undefined : finish.tone}
          data-finish-seq={item.seq}
        >
          <div className={styles.finishLine}>
            {event.head_sha && (
              <span>
                <RiGitBranchLine className={ui.iconXs} aria-hidden="true" />
                <span className={ui.mono}>{shortSha(event.head_sha)}</span>{' '}
                {event.pushed ? 'pushed' : 'not pushed'}
              </span>
            )}
            {usage.input_tokens > 0 && (
              <span>
                {Math.round(usage.input_tokens / 1000)}k in ·{' '}
                {(usage.output_tokens / 1000).toFixed(1)}k out
                {usage.cost_usd ? ` · $${usage.cost_usd.toFixed(2)}` : ''}
              </span>
            )}
          </div>
          {event.error && <div className={styles.errLine}>{event.error}</div>}
          {event.pr_url && (
            <ButtonLink
              href={event.pr_url}
              target="_blank"
              rel="noopener noreferrer"
              variant="secondary"
              size="small"
              iconStart={<RiGitPullRequestLine aria-hidden="true" />}
              iconEnd={<RiExternalLinkLine aria-hidden="true" />}
              className={styles.finishPr}
            >
              Pull request #{prNumber(event.pr_url)}
            </ButtonLink>
          )}
        </div>
      </Row>
    );
  },
  agent_error: ({ item, ctx }) => (
    <Row item={item} ctx={ctx} icon={RiAlertLine} dot="err">
      <div className={styles.evTitle}>
        <b>Agent {item.event.status.replace('_', ' ')}</b>
        <Time ts={item.event.ts} />
      </div>
      <div className={styles.errLine}>{item.event.error}</div>
    </Row>
  ),
  unknown: ({ item, ctx }) => (
    <Row item={item} ctx={ctx} icon={RiBox3Line}>
      <div className={styles.evTitle}>
        <b>{item.event.type}</b>
      </div>
      <pre className={styles.out}>{JSON.stringify(item.event, null, 2)}</pre>
    </Row>
  ),
};

export function TimelineItem(props: { item: Item; ctx: TimelineContext }) {
  const Render = RENDER[props.item.kind] as (p: {
    item: Item;
    ctx: TimelineContext;
  }) => ReactNode;
  return <Render item={props.item} ctx={props.ctx} />;
}
