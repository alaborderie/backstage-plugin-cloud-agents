import { forwardRef } from 'react';
import { ButtonLink } from '@backstage/ui';
import {
  RiBox3Line,
  RiDashboard3Line,
  RiExternalLinkLine,
  RiGitBranchLine,
  RiGitPullRequestLine,
} from '@remixicon/react';
import type { Agent } from '@alaborderie/plugin-cloud-agents-common';
import { clock, prNumber, repoName, shortSha } from '../../format';
import { ui } from '../ui';
import type { Timeline } from './timeline';
import styles from './Detail.module.css';

const tokens = (n: number) => `${n.toLocaleString('en')} tokens`;

export const PullRequestCard = forwardRef<HTMLDivElement, { agent: Agent }>(
  (props, ref) => {
    const { agent } = props;
    return (
      <div ref={ref} className={`${ui.card} ${styles.railCard}`}>
        <h3>
          <RiGitPullRequestLine className={ui.icon} aria-hidden="true" />
          Pull request
        </h3>
        {agent.prUrl ? (
          <>
            <a
              className={styles.prTitle}
              href={agent.prUrl}
              target="_blank"
              rel="noopener noreferrer"
            >
              {repoName(agent.repo)} #{prNumber(agent.prUrl)}
            </a>
            <div className={ui.meta}>
              <span>
                <RiGitBranchLine className={ui.iconXs} aria-hidden="true" />
                {agent.branch}
              </span>
              <span>into {agent.base}</span>
            </div>
            <ButtonLink
              href={agent.prUrl}
              target="_blank"
              rel="noopener noreferrer"
              variant="secondary"
              size="small"
              iconEnd={<RiExternalLinkLine aria-hidden="true" />}
              className={styles.railButton}
            >
              Open on GitHub
            </ButtonLink>
          </>
        ) : (
          <p className={styles.railEmpty}>
            {agent.status === 'failed' || agent.status === 'stopped'
              ? 'No pull request. Pushed commits stay on'
              : 'The agent opens one when its work is ready. Its commits land on'}{' '}
            <span className={ui.mono}>{agent.branch}</span>.
          </p>
        )}
      </div>
    );
  },
);

function UsageCard(props: { timeline: Timeline }) {
  const { usage, rateLimit } = props.timeline;
  const percent = rateLimit?.utilization
    ? Math.round(rateLimit.utilization * 100)
    : 0;
  return (
    <div className={`${ui.card} ${styles.railCard}`}>
      <h3>
        <RiDashboard3Line className={ui.icon} aria-hidden="true" />
        Usage
      </h3>
      <dl className={styles.kv}>
        <dt>Input</dt>
        <dd>{tokens(usage.input)}</dd>
        <dt>Cached</dt>
        <dd>
          {usage.input ? Math.round((usage.cached / usage.input) * 100) : 0}%
        </dd>
        <dt>Output</dt>
        <dd>{tokens(usage.output)}</dd>
        <dt>Cost</dt>
        <dd>
          {usage.costUsd === null
            ? 'not reported'
            : `$${usage.costUsd.toFixed(2)}`}
        </dd>
      </dl>
      {rateLimit && (
        <>
          <div
            className={styles.meter}
            role="meter"
            aria-label={`Rate limit ${rateLimit.window ?? ''} used`}
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={percent}
            data-status={rateLimit.status}
          >
            <i style={{ transform: `scaleX(${percent / 100})` }} />
          </div>
          <div className={ui.meta}>
            <span>
              {rateLimit.window ? `${rateLimit.window} window · ` : ''}
              {percent}% used
            </span>
            {rateLimit.resets_at && (
              <span>resets {clock(rateLimit.resets_at)}</span>
            )}
          </div>
        </>
      )}
    </div>
  );
}

function WorkspaceCard(props: { agent: Agent; timeline: Timeline }) {
  const { agent, timeline } = props;
  return (
    <div className={`${ui.card} ${styles.railCard}`}>
      <h3>
        <RiBox3Line className={ui.icon} aria-hidden="true" />
        Workspace
      </h3>
      <dl className={styles.kv}>
        <dt>Harness</dt>
        <dd>
          {agent.harness} · {agent.effort}
        </dd>
        <dt>Model</dt>
        <dd className={ui.mono} title={agent.model}>
          {agent.model}
        </dd>
        {timeline.headSha && (
          <>
            <dt>Head</dt>
            <dd className={ui.mono}>{shortSha(timeline.headSha)}</dd>
          </>
        )}
        {timeline.runStarted && (
          <>
            <dt>Runner</dt>
            <dd className={ui.mono}>{timeline.runStarted.runner_version}</dd>
          </>
        )}
        <dt>Agent</dt>
        <dd className={ui.mono}>{agent.id}</dd>
        {agent.parent && (
          <>
            <dt>From</dt>
            <dd>
              {agent.parent.source === 't3' ? 'T3' : agent.parent.source}
              {agent.parent.label ? ` · ${agent.parent.label}` : ''}
            </dd>
          </>
        )}
      </dl>
    </div>
  );
}

export function Rail(props: {
  agent: Agent;
  timeline: Timeline;
  prCardRef: React.Ref<HTMLDivElement>;
}) {
  return (
    <aside className={styles.rail} aria-label="Agent summary">
      {(props.agent.kind !== 'hub' || props.agent.prUrl) && (
        <PullRequestCard ref={props.prCardRef} agent={props.agent} />
      )}
      <UsageCard timeline={props.timeline} />
      <WorkspaceCard agent={props.agent} timeline={props.timeline} />
    </aside>
  );
}
