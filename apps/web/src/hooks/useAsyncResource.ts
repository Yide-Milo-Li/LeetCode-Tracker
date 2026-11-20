/**
 * Load a value for the current inputs and drop responses that belong to older inputs.
 *
 * Replaces the hand-written `let active = true … return () => { active = false }` pattern:
 * every run gets a fresh `AbortController`, the previous run is aborted when inputs change or
 * the component unmounts, and results from an aborted run are never applied. Passing the signal
 * on to `api.*` calls that accept `{ signal }` also cancels the underlying request.
 *
 * Semantics match the effects it replaces:
 * - `data` keeps the last successful value while a reload is in flight (no flash of empty UI).
 * - `error` is cleared only by a later success, so a failed reload keeps the prior data visible.
 * - `loading` is true from the start of each run until it settles.
 * - Disabling a retained view's read cancels it and keeps its last result until re-enabled.
 */
import { useEffect, useRef, useState, type DependencyList } from 'react';

export interface AsyncResource<T> {
  data: T | undefined;
  /** Raw failure cause; localize at render time so it follows the current language. */
  error: unknown;
  loading: boolean;
}

export function useAsyncResource<T>(load: (signal: AbortSignal) => Promise<T>, deps: DependencyList, enabled = true): AsyncResource<T> {
  const [state, setState] = useState<AsyncResource<T>>({ data: undefined, error: null, loading: true });
  // Read the latest loader without making its identity an effect dependency; callers list inputs in `deps`.
  const loadRef = useRef(load);
  loadRef.current = load;

  useEffect(() => {
    if (!enabled) return;
    const controller = new AbortController();
    setState((prior) => (prior.loading ? prior : { ...prior, loading: true }));
    loadRef.current(controller.signal).then(
      (data) => {
        if (!controller.signal.aborted) setState({ data, error: null, loading: false });
      },
      (error: unknown) => {
        if (!controller.signal.aborted) setState((prior) => ({ ...prior, error, loading: false }));
      },
    );
    return () => controller.abort();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `deps` are the caller's inputs.
  }, [enabled, ...deps]);

  return state;
}
