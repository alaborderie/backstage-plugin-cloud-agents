import { useCallback, useEffect, useState } from 'react';

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
  }>({ loading: true });
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

/** The current time, refreshed every `ms` for "ago" labels. */
export function useNow(ms: number): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), ms);
    return () => clearInterval(timer);
  }, [ms]);
  return now;
}
