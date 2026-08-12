import { useCallback, useEffect, useRef, useState } from 'react';

export type CopyTextState = 'idle' | 'copied' | 'failed';

const COPY_FEEDBACK_DURATION_MS = 2_000;

export const copyTextToClipboard = (
  text: string,
  clipboard: Pick<Clipboard, 'writeText'> = navigator.clipboard,
): Promise<void> => clipboard.writeText(text);

export const useCopyText = (text: string) => {
  const [state, setState] = useState<CopyTextState>('idle');
  const resetTimeout = useRef<number | null>(null);

  const clearReset = useCallback(() => {
    if (resetTimeout.current !== null) {
      window.clearTimeout(resetTimeout.current);
      resetTimeout.current = null;
    }
  }, []);

  useEffect(() => clearReset, [clearReset]);
  useEffect(() => {
    clearReset();
    setState('idle');
  }, [clearReset, text]);

  const copy = useCallback(async () => {
    clearReset();
    try {
      await copyTextToClipboard(text);
      setState('copied');
    } catch {
      setState('failed');
    }
    resetTimeout.current = window.setTimeout(() => {
      setState('idle');
      resetTimeout.current = null;
    }, COPY_FEEDBACK_DURATION_MS);
  }, [clearReset, text]);

  return { copy, state };
};
