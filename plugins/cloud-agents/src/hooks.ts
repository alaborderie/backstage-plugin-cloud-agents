import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import {
  alertApiRef,
  configApiRef,
  toastApiRef,
  useApi,
  useApiHolder,
} from '@backstage/frontend-plugin-api';
import {
  DEFAULT_TIERS,
  type Agent,
  type AgentEventEnvelope,
  type Harness,
  type TierInfo,
} from '@alaborderie/plugin-cloud-agents-common';
import { cloudAgentsApiRef } from './api';

/** The path the plugin page is mounted at, such as `/cloud-agents`. */
export const BasePathContext = createContext('/cloud-agents');

export function useBasePath(): string {
  return useContext(BasePathContext);
}

export interface Loadable<T> {
  value: T | undefined;
  error: Error | undefined;
  loading: boolean;
  reload(): void;
}

/** Runs `load` on mount, when `deps` change, and on `reload()`. */
export function useLoad<T>(
  load: () => Promise<T>,
  deps: readonly unknown[],
): Loadable<T> {
  const [state, setState] = useState<{
    value?: T;
    error?: Error;
    loading: boolean;
  }>({
    loading: true,
  });
  const [generation, setGeneration] = useState(0);
  useEffect(() => {
    let cancelled = false;
    setState(s => ({ ...s, loading: true }));
    load().then(
      value => !cancelled && setState({ value, loading: false }),
      error =>
        !cancelled &&
        setState(s => ({
          value: s.value,
          error: error as Error,
          loading: false,
        })),
    );
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, generation]);
  const reload = useCallback(() => setGeneration(g => g + 1), []);
  return {
    value: state.value,
    error: state.error,
    loading: state.loading,
    reload,
  };
}

/** Calls `reload` every `ms` while the page is visible. */
export function usePoll(reload: () => void, ms: number) {
  useEffect(() => {
    const timer = setInterval(() => {
      if (document.visibilityState !== 'hidden') reload();
    }, ms);
    return () => clearInterval(timer);
  }, [reload, ms]);
}

const RECONNECT_MS = 3000;
/** Events that arrive this soon after the stream opens are history, not news. */
const HISTORY_WINDOW_MS = 700;

export interface AgentEvents {
  events: AgentEventEnvelope[];
  /** The last seq that came with the replay; later events arrived live. */
  historySeq: number;
  live: boolean;
  error: Error | undefined;
  restart(): void;
}

/**
 * The agent's events, live. It resumes after a dropped connection from the
 * last seq it saw. `restart()` reconnects after the agent left a terminal
 * status, for example after a follow-up message.
 */
export function useAgentEvents(
  agentId: string,
  onEvent: (envelope: AgentEventEnvelope) => void,
): AgentEvents {
  const api = useApi(cloudAgentsApiRef);
  const [events, setEvents] = useState<AgentEventEnvelope[]>([]);
  const [historySeq, setHistorySeq] = useState(0);
  const [live, setLive] = useState(true);
  const [error, setError] = useState<Error>();
  const [generation, setGeneration] = useState(0);
  const lastSeq = useRef(0);
  const openedAt = useRef<number | undefined>(undefined);
  const onEventRef = useRef(onEvent);
  onEventRef.current = onEvent;

  useEffect(() => {
    const controller = new AbortController();
    const receive = (envelope: AgentEventEnvelope) => {
      if (envelope.seq <= lastSeq.current) return;
      lastSeq.current = envelope.seq;
      if (
        openedAt.current !== undefined &&
        Date.now() - openedAt.current < HISTORY_WINDOW_MS
      ) {
        setHistorySeq(envelope.seq);
      }
      setEvents(prev => [...prev, envelope]);
      onEventRef.current(envelope);
    };
    setLive(true);
    (async () => {
      while (!controller.signal.aborted) {
        try {
          openedAt.current ??= Date.now();
          await api.streamEvents(
            agentId,
            lastSeq.current,
            receive,
            controller.signal,
          );
          setLive(false);
          setError(undefined);
          return;
        } catch (e) {
          if (controller.signal.aborted) return;
          setError(e as Error);
          await new Promise(r => setTimeout(r, RECONNECT_MS));
        }
      }
    })();
    return () => controller.abort();
  }, [api, agentId, generation]);

  const restart = useCallback(() => setGeneration(g => g + 1), []);
  return { events, historySeq, live, error, restart };
}

export function useAgent(agentId: string): Loadable<Agent> {
  const api = useApi(cloudAgentsApiRef);
  return useLoad(() => api.getAgent(agentId), [api, agentId]);
}

/** The current time, refreshed every `ms` for timers and "ago" labels. */
export function useNow(ms = 1000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), ms);
    return () => clearInterval(timer);
  }, [ms]);
  return now;
}

export function usePrefersReducedMotion(): boolean {
  const query = '(prefers-reduced-motion: reduce)';
  const [reduced, setReduced] = useState(
    () => typeof window !== 'undefined' && !!window.matchMedia?.(query).matches,
  );
  useEffect(() => {
    const media = window.matchMedia?.(query);
    if (!media) return undefined;
    const update = () => setReduced(media.matches);
    media.addEventListener('change', update);
    return () => media.removeEventListener('change', update);
  }, []);
  return reduced;
}

/** The tiers of app-config `cloudAgents.tiers`, else flash, sol, and opus. */
export function useTiers(): TierInfo[] {
  const config = useApi(configApiRef);
  return useMemo(() => {
    const tiers = config.getOptionalConfig('cloudAgents.tiers');
    if (!tiers) return [...DEFAULT_TIERS];
    return tiers.keys().map(name => {
      const tier = tiers.getConfig(name);
      return {
        name,
        harness: tier.getString('harness') as Harness,
        model: tier.getString('model'),
        effort: tier.getOptionalString('effort') ?? 'high',
      };
    });
  }, [config]);
}

/** The tier an agent runs on, when its harness and model match one. */
export function tierOf(
  tiers: readonly TierInfo[],
  agent: Pick<Agent, 'harness' | 'model'>,
): TierInfo | undefined {
  return tiers.find(
    t => t.harness === agent.harness && t.model === agent.model,
  );
}

export interface Notice {
  title: string;
  description?: string;
  status?: 'info' | 'success' | 'warning' | 'danger';
  link?: { label: string; href: string };
}

const ALERT_SEVERITY = {
  success: 'success',
  info: 'info',
  warning: 'warning',
  danger: 'error',
} as const;

/**
 * Posts a toast through the upstream toast API, or through the alert API in
 * apps that have no toast API.
 */
export function useNotify(): (notice: Notice) => void {
  const apis = useApiHolder();
  return useCallback(
    (notice: Notice) => {
      const toast = apis.get(toastApiRef);
      if (toast) {
        toast.post({
          title: notice.title,
          ...(notice.description && { description: notice.description }),
          status: notice.status ?? 'success',
          ...(notice.link && { links: [notice.link] }),
          timeout: 6000,
        });
        return;
      }
      apis.get(alertApiRef)?.post({
        message: notice.description
          ? `${notice.title}. ${notice.description}`
          : notice.title,
        severity: ALERT_SEVERITY[notice.status ?? 'success'],
        display: 'transient',
      });
    },
    [apis],
  );
}

export interface AgentsState extends Loadable<Agent[]> {
  needsYou: number;
}

export const AgentsContext = createContext<AgentsState | undefined>(undefined);

const LIST_REFRESH_MS = 5000;

/** The user's agents, polled every 5 s while the page is visible. */
export function useAgentsSource(): AgentsState {
  const api = useApi(cloudAgentsApiRef);
  const agents = useLoad(() => api.listAgents(), [api]);
  usePoll(agents.reload, LIST_REFRESH_MS);
  const needsYou = (agents.value ?? []).filter(
    a => a.status === 'needs_input',
  ).length;
  return { ...agents, needsYou };
}

export function useAgents(): AgentsState {
  const agents = useContext(AgentsContext);
  if (!agents) throw new Error('useAgents needs an AgentsContext provider');
  return agents;
}
