import { useEffect, useState } from "react";

export interface BackendHealth {
  ok: boolean;
  checking: boolean;
}

export function useBackendHealth(): BackendHealth {
  const [state, setState] = useState<BackendHealth>({
    ok: false,
    checking: true,
  });

  useEffect(() => {
    let cancelled = false;
    const tick = async () => {
      try {
        const response = await fetch("/health");
        if (!cancelled) setState({ ok: response.ok, checking: false });
      } catch {
        if (!cancelled) setState({ ok: false, checking: false });
      }
    };
    void tick();
    const timer = window.setInterval(() => void tick(), 15_000);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, []);

  return state;
}
