export type RequestDeadline = Readonly<{
  signal: AbortSignal;
  didTimeout: () => boolean;
  dispose: () => void;
}>;

export const createRequestDeadline = (
  parentSignal: AbortSignal | undefined,
  timeoutMs: number,
): RequestDeadline => {
  const controller = new AbortController();
  let timedOut = false;
  const abortFromParent = (): void => controller.abort(parentSignal?.reason);
  if (parentSignal?.aborted) {
    abortFromParent();
  } else {
    parentSignal?.addEventListener('abort', abortFromParent, { once: true });
  }
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort(new Error('Provider request deadline exceeded.'));
  }, timeoutMs);
  timer.unref();
  return {
    signal: controller.signal,
    didTimeout: () => timedOut,
    dispose: () => {
      clearTimeout(timer);
      parentSignal?.removeEventListener('abort', abortFromParent);
    },
  };
};
