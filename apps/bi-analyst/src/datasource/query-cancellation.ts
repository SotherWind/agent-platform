/** Runs a driver query with one abort path and one bounded timer. */
export function runCancellableQuery<T>(input: {
  signal?: AbortSignal;
  timeoutMs?: number;
  query: (signal: AbortSignal) => Promise<T>;
}): Promise<T> {
  const controller = new AbortController();
  let settled = false;
  let timer: ReturnType<typeof setTimeout> | undefined;

  return new Promise<T>((resolve, reject) => {
    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      input.signal?.removeEventListener("abort", onAbort);
      fn();
    };
    const onAbort = () => {
      controller.abort();
      finish(() => reject(new Error("Query cancelled")));
    };

    if (input.signal?.aborted) {
      onAbort();
      return;
    }
    input.signal?.addEventListener("abort", onAbort, { once: true });
    if (input.timeoutMs !== undefined && input.timeoutMs > 0) {
      timer = setTimeout(() => {
        controller.abort();
        finish(() => reject(new Error("Query timeout")));
      }, input.timeoutMs);
    }

    void input
      .query(controller.signal)
      .then((value) => finish(() => resolve(value)))
      .catch((error) => finish(() => reject(error)));
  });
}
