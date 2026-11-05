import { useId, useState } from 'react';
import { RiArrowRightSLine, RiErrorWarningLine } from '@remixicon/react';
import type { ToolItem } from '@alaborderie/plugin-assistant-common';
import { FAMILY_ICON, reasoningAnswer, toolFamily, toolLabel } from '../tools';
import { Markdown } from './Markdown';
import { Spinner, ui } from './ui';
import styles from './Transcript.module.css';

const pretty = (value: unknown) => JSON.stringify(value, null, 2) ?? 'null';

/**
 * One tool call on one line; it opens to show the input and the output. It
 * spins only while the turn that runs it is `live` in this page.
 */
export function ToolChip(props: { item: ToolItem; live: boolean }) {
  const { item } = props;
  const [open, setOpen] = useState(false);
  const panelId = useId();
  const Icon = FAMILY_ICON[toolFamily(item.name)];
  const label = toolLabel(item);
  const answer = reasoningAnswer(item);
  return (
    <div className={styles.tool} data-status={item.status}>
      <button
        type="button"
        className={styles.toolHead}
        aria-expanded={open}
        aria-controls={panelId}
        onClick={() => setOpen(o => !o)}
        title={label}
      >
        <Icon className={ui.iconXs} aria-hidden="true" />
        <span className={styles.toolLabel}>{label}</span>
        {props.live && item.status === 'running' && <Spinner label="Running" />}
        {item.status === 'error' && (
          <RiErrorWarningLine
            className={`${ui.iconXs} ${styles.toolError}`}
            aria-label="Failed"
            role="img"
          />
        )}
        <RiArrowRightSLine
          className={`${ui.iconXs} ${styles.chevron}`}
          aria-hidden="true"
        />
      </button>
      {open && (
        <div id={panelId} className={styles.toolBody}>
          <div className={styles.toolSection}>Input</div>
          <pre>{pretty(item.input)}</pre>
          {item.error && (
            <>
              <div className={styles.toolSection}>Error</div>
              <pre className={styles.toolError}>{item.error}</pre>
            </>
          )}
          {item.status !== 'running' && (
            <>
              <div className={styles.toolSection}>Output</div>
              {answer !== undefined ? (
                <Markdown text={answer} />
              ) : (
                <pre>{pretty(item.output)}</pre>
              )}
            </>
          )}
        </div>
      )}
    </div>
  );
}
