import type { ReactElement } from 'react';
import {
  StatusAborted,
  StatusError,
  StatusOK,
  StatusPending,
  StatusRunning,
  StatusWarning,
} from '@backstage/core-components';
import type {
  AgentStatus,
  RunStatus,
} from '@alaborderie/plugin-cloud-agents-common';

const INDICATORS: Record<
  AgentStatus,
  (props: { children: string }) => ReactElement
> = {
  queued: StatusPending,
  running: StatusRunning,
  needs_input: StatusWarning,
  succeeded: StatusOK,
  failed: StatusError,
  stopped: StatusAborted,
};

export function StatusChip(props: { status: AgentStatus | RunStatus }) {
  const Indicator = INDICATORS[props.status];
  return <Indicator>{props.status.replace('_', ' ')}</Indicator>;
}
