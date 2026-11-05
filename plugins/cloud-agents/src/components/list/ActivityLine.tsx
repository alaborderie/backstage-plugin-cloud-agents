import { VisuallyHidden } from '@backstage/ui';
import { RiArrowRightSLine } from '@remixicon/react';
import type { AgentActivity } from '@alaborderie/plugin-cloud-agents-common';
import { KIND_ICON, ui } from '../ui';
import styles from './List.module.css';

/** What a running agent does right now. A new activity cross-fades in. */
export function ActivityLine(props: { activity: AgentActivity }) {
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
    <div className={styles.activity} aria-live="off" title={text}>
      <Icon className={ui.iconXs} aria-hidden="true" />
      <span key={activity.ts}>
        <VisuallyHidden>Now: </VisuallyHidden>
        {text}
      </span>
    </div>
  );
}
