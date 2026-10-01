import { useCallback, useEffect, useRef, useState } from "react";
import {
  useRealtime,
  useRealtimeConnectionState,
} from "@get-bb/plugin-sdk/app";

export function useResource<T>(
  key: string,
  load: () => Promise<T>,
  intervalMs = 10000,
) {
  const loader = useRef(load);
  loader.current = load;
  const [revision, setRevision] = useState(0);
  const [state, setState] = useState<{ key: string; data?: T; error?: string }>(
    { key },
  );
  const refresh = useCallback(() => setRevision((value) => value + 1), []);
  const connection = useRealtimeConnectionState();
  useRealtime("changed", refresh);
  useEffect(() => {
    let disposed = false;
    let timer: ReturnType<typeof setTimeout>;
    async function fetch() {
      try {
        const data = await loader.current();
        if (!disposed) setState({ key, data });
      } catch (cause) {
        if (!disposed)
          setState((previous) => ({
            key,
            data: previous.key === key ? previous.data : undefined,
            error: cause instanceof Error ? cause.message : String(cause),
          }));
      } finally {
        if (!disposed && intervalMs > 0) timer = setTimeout(fetch, intervalMs);
      }
    }
    void fetch();
    return () => {
      disposed = true;
      clearTimeout(timer);
    };
  }, [key, revision, intervalMs, connection]);
  return {
    data: state.key === key ? state.data : undefined,
    error: state.key === key ? state.error : undefined,
    refresh,
  };
}
