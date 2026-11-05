import { Link } from 'react-router-dom';
import { RiNodeTree, RiQuestionLine } from '@remixicon/react';
import type { Agent } from '@alaborderie/plugin-cloud-agents-common';
import { ago, plural } from '../../format';
import { useBasePath, useNow, usePoll } from '../../hooks';
import { PrChip, StatusPill, ui } from '../ui';
import styles from './Detail.module.css';

/** A waiting hub gets no events while its children work, so this polls. */
const CHILDREN_REFRESH_MS = 5000;

/** The agents a hub started, oldest first, each linking to its own page. */
export function HubChildren(props: { agent: Agent; reload(): void }) {
  const { children } = props.agent;
  const base = useBasePath();
  const now = useNow();
  usePoll(props.reload, CHILDREN_REFRESH_MS);
  return (
    <section
      className={`${ui.card} ${styles.hubChildren}`}
      aria-labelledby="hub-children"
    >
      <h3 id="hub-children">
        <RiNodeTree className={ui.icon} aria-hidden="true" />
        Children
        <span className={styles.hubCount}>{children.length}</span>
      </h3>
      {children.length ? (
        <ol className={styles.childList}>
          {children.map(child => (
            <li key={child.id} className={styles.child}>
              <div className={styles.childMain}>
                <Link
                  className={styles.childTitle}
                  to={`${base}/agents/${child.id}`}
                >
                  {child.title}
                </Link>
                <div className={ui.meta}>
                  <span className={ui.mono}>{child.branch}</span>
                  <span>updated {ago(child.updatedAt, now)}</span>
                </div>
              </div>
              <div className={styles.childSide}>
                {child.openQuestions > 0 && (
                  <span className={styles.childAsks}>
                    <RiQuestionLine className={ui.iconXs} aria-hidden="true" />
                    {plural(child.openQuestions, 'open question')}
                  </span>
                )}
                {child.prUrl && <PrChip url={child.prUrl} />}
                <StatusPill status={child.status} />
              </div>
            </li>
          ))}
        </ol>
      ) : (
        <p className={styles.railEmpty}>
          No children yet. The hub starts one agent per task as it splits its
          objective.
        </p>
      )}
    </section>
  );
}
