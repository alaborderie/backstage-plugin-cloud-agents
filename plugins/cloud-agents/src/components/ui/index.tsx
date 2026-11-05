import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import {
  RiAlertLine,
  RiBox3Line,
  RiCheckLine,
  RiCloseLine,
  RiExternalLinkLine,
  RiFileTextLine,
  RiFlashlightLine,
  RiFlowChart,
  RiGitPullRequestLine,
  RiGlobalLine,
  RiHourglassLine,
  RiPencilLine,
  RiPlugLine,
  RiRobot2Line,
  RiSearchLine,
  RiStopLine,
  RiSunLine,
  RiTerminalBoxLine,
  RiTimeLine,
  RiVipDiamondLine,
  type RemixiconComponentType,
} from '@remixicon/react';
import type {
  AgentStatus,
  RunStatus,
  ToolKind,
} from '@alaborderie/plugin-cloud-agents-common';
import { STATUS_LABEL, prNumber } from '../../format';
import { usePrefersReducedMotion } from '../../hooks';
import styles from './ui.module.css';

export { styles as ui };

export type Icon = RemixiconComponentType;

/** The default tiers' glyphs. Other tiers get the robot. */
export const TIER_ICON: Record<string, Icon> = {
  flash: RiFlashlightLine,
  sol: RiSunLine,
  opus: RiVipDiamondLine,
};

export const tierIcon = (tier: string | undefined): Icon =>
  (tier && TIER_ICON[tier]) || RiRobot2Line;

export const KIND_ICON: Record<ToolKind, Icon> = {
  shell: RiTerminalBoxLine,
  read: RiFileTextLine,
  edit: RiPencilLine,
  search: RiSearchLine,
  web: RiGlobalLine,
  mcp: RiPlugLine,
  task: RiFlowChart,
  other: RiBox3Line,
};

/** The row glyph of a finished or waiting agent; running ones show their tier. */
export const STATUS_GLYPH: Partial<Record<AgentStatus, Icon>> = {
  succeeded: RiCheckLine,
  failed: RiCloseLine,
  stopped: RiStopLine,
  queued: RiTimeLine,
  waiting: RiHourglassLine,
};

/**
 * Moves focus into an inline editor or confirmation when it opens, to its
 * first field or button, so keyboard users land where the action is.
 */
export function useFocusWhen<T extends HTMLElement>(active: boolean) {
  const ref = useRef<T>(null);
  useEffect(() => {
    if (active) {
      ref.current
        ?.querySelector<HTMLElement>('input, textarea, button')
        ?.focus();
    }
  }, [active]);
  return ref;
}

export function LiveDot() {
  return <span className={styles.liveDot} aria-hidden="true" />;
}

/**
 * The agent's status as a word, never color alone. When the status changes
 * on screen, the pill pops into its new state.
 */
export function StatusPill(props: {
  status: AgentStatus | RunStatus;
  large?: boolean;
}) {
  const initial = useRef(props.status);
  return (
    <span
      key={props.status}
      className={`${styles.pill} ${props.large ? styles.pillLg : ''}`}
      data-status={props.status}
      data-morph={props.status === initial.current ? undefined : ''}
    >
      {props.status === 'running' && <LiveDot />}
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

export function Kbd(props: { children: ReactNode }) {
  return (
    <span className={styles.kbd} aria-hidden="true">
      {props.children}
    </span>
  );
}

export function StateMessage(props: {
  icon: Icon;
  title: string;
  children?: ReactNode;
  action?: ReactNode;
  tone?: 'error';
  role?: 'alert' | 'status';
  className?: string;
}) {
  const IconComponent = props.icon;
  return (
    <div
      className={`${styles.state} ${props.className ?? ''}`}
      data-tone={props.tone}
      role={props.role}
    >
      <span className={styles.halo} aria-hidden="true">
        <IconComponent />
      </span>
      <h3>{props.title}</h3>
      {props.children && <p>{props.children}</p>}
      {props.action && <div className={styles.stateAction}>{props.action}</div>}
    </div>
  );
}

export function InlineAlert(props: {
  tone: 'warn' | 'ok' | 'error';
  children: ReactNode;
  role?: 'alert' | 'status';
}) {
  const IconComponent = props.tone === 'ok' ? RiCheckLine : RiAlertLine;
  return (
    <div
      className={styles.inlineAlert}
      data-tone={props.tone}
      role={props.role ?? (props.tone === 'error' ? 'alert' : 'status')}
    >
      <IconComponent className={styles.icon} aria-hidden="true" />
      <span>{props.children}</span>
    </div>
  );
}

interface Burst {
  id: number;
  x: number;
  y: number;
  sparks: Array<{ x: number; y: number; r: number }>;
}

const SPARKS = 16;
const BURST_MS = 1300;

/** Plays a spark burst from the top of an element. */
export type Celebrate = (element: Element | null | undefined) => void;

const CelebrateContext = createContext<Celebrate>(() => {});

export const useCelebrate = () => useContext(CelebrateContext);

/**
 * Hosts the success celebration. It sits outside any animated container, so
 * the fixed-position sparks land where the element is. Reduced motion skips
 * it entirely.
 */
export function CelebrationLayer(props: { children: ReactNode }) {
  const reduced = usePrefersReducedMotion();
  const [bursts, setBursts] = useState<Burst[]>([]);
  const next = useRef(0);
  const celebrate = useCallback<Celebrate>(
    element => {
      if (reduced || !element) return;
      const rect = element.getBoundingClientRect();
      const id = next.current++;
      const sparks = Array.from({ length: SPARKS }, (_, k) => {
        const angle = (k / SPARKS) * Math.PI * 2 + Math.random() * 0.4;
        const distance = 30 + Math.random() * 40;
        return {
          x: Math.cos(angle) * distance,
          y: Math.sin(angle) * distance - 12,
          r: Math.round(Math.random() * 240),
        };
      });
      setBursts(b => [
        ...b,
        {
          id,
          x: rect.left + Math.min(rect.width, 200) / 2,
          y: rect.top + 20,
          sparks,
        },
      ]);
      setTimeout(
        () => setBursts(b => b.filter(burst => burst.id !== id)),
        BURST_MS,
      );
    },
    [reduced],
  );
  return (
    <CelebrateContext.Provider value={celebrate}>
      {props.children}
      {bursts.map(burst => (
        <div
          key={burst.id}
          className={styles.burst}
          style={{ left: burst.x, top: burst.y }}
          aria-hidden="true"
        >
          {burst.sparks.map((s, k) => (
            <i
              key={k}
              style={
                {
                  '--k': k,
                  '--x': `${s.x}px`,
                  '--y': `${s.y}px`,
                  '--r': `${s.r}deg`,
                } as React.CSSProperties
              }
            />
          ))}
        </div>
      ))}
    </CelebrateContext.Provider>
  );
}
