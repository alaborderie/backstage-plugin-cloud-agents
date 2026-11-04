import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
} from 'react';
import { useApi } from '@backstage/frontend-plugin-api';
import type {
  Agent,
  AgentEventEnvelope,
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
        !cancelled && setState({ error: error as Error, loading: false }),
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

const RECONNECT_MS = 3000;

/**
 * The agent's events, live. It resumes after a dropped connection from the
 * last seq it saw. `restart()` reconnects after the agent left a terminal
 * status, for example after a follow-up message.
 */
export function useAgentEvents(
  agentId: string,
  onEvent: (envelope: AgentEventEnvelope) => void,
): {
  events: AgentEventEnvelope[];
  live: boolean;
  error: Error | undefined;
  restart(): void;
} {
  const api = useApi(cloudAgentsApiRef);
  const [events, setEvents] = useState<AgentEventEnvelope[]>([]);
  const [live, setLive] = useState(true);
  const [error, setError] = useState<Error>();
  const [generation, setGeneration] = useState(0);

  const lastSeq = useRef(0);

  useEffect(() => {
    const controller = new AbortController();
    const receive = (envelope: AgentEventEnvelope) => {
      if (envelope.seq <= lastSeq.current) return;
      lastSeq.current = envelope.seq;
      setEvents(prev => [...prev, envelope]);
      onEvent(envelope);
    };
    setLive(true);
    (async () => {
      while (!controller.signal.aborted) {
        try {
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
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [api, agentId, generation]);

  const restart = useCallback(() => setGeneration(g => g + 1), []);
  return { events, live, error, restart };
}

export function useAgent(agentId: string): Loadable<Agent> {
  const api = useApi(cloudAgentsApiRef);
  return useLoad(() => api.getAgent(agentId), [api, agentId]);
}
