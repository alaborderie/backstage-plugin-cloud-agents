import { RiExternalLinkLine, RiGitPullRequestLine } from '@remixicon/react';
import {
  isTerminalAgentStatus,
  type AgentStatus,
} from '@alaborderie/plugin-cloud-agents-common';
import { STATUS_LABEL, prNumber } from '../format';
import styles from './ui.module.css';

export { styles as ui };

export function LiveDot() {
  return <span className={styles.liveDot} aria-hidden="true" />;
}

export function Spinner(props: { label?: string }) {
  return (
    <span
      className={styles.spinner}
      role={props.label ? 'status' : undefined}
      aria-label={props.label}
      aria-hidden={props.label ? undefined : true}
    />
  );
}

/** The agent's status as a word, with a live dot while it is not terminal. */
export function StatusPill(props: { status: AgentStatus }) {
  return (
    <span className={styles.pill} data-status={props.status}>
      {!isTerminalAgentStatus(props.status) && <LiveDot />}
      {STATUS_LABEL[props.status]}
    </span>
  );
}

/** A pull request's number, opening it on GitHub. */
export function PrChip(props: { url: string }) {
  return (
    <a
      className={styles.prLink}
      href={props.url}
      target="_blank"
      rel="noopener noreferrer"
      aria-label={`Pull request #${prNumber(props.url)}`}
    >
      <RiGitPullRequestLine className={styles.iconXs} aria-hidden="true" />#
      {prNumber(props.url)}
      <RiExternalLinkLine className={styles.iconXs} aria-hidden="true" />
    </a>
  );
}
