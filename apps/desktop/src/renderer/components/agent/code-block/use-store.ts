import { useCallback, useEffect, useRef, useState } from 'react';

import { copyCodeToClipboard } from './clipboard';
import type { CodeBlockCopyState, CodeBlockStore } from './types';

const COPY_FEEDBACK_DURATION_MS = 2_000;

export const useStore = (code: string): CodeBlockStore => {
  const [copyState, setCopyState] = useState<CodeBlockCopyState>('idle');
  const resetTimeoutRef = useRef<number | null>(null);

  const clearResetTimeout = useCallback((): void => {
    if (resetTimeoutRef.current !== null) {
      window.clearTimeout(resetTimeoutRef.current);
      resetTimeoutRef.current = null;
    }
  }, []);

  useEffect(
    () => (): void => {
      clearResetTimeout();
    },
    [clearResetTimeout],
  );

  useEffect(() => {
    clearResetTimeout();
    setCopyState('idle');
  }, [clearResetTimeout, code]);

  const copy = useCallback(async (): Promise<void> => {
    clearResetTimeout();
    try {
      await copyCodeToClipboard(code);
      setCopyState('copied');
    } catch {
      setCopyState('failed');
    }
    resetTimeoutRef.current = window.setTimeout(() => {
      setCopyState('idle');
      resetTimeoutRef.current = null;
    }, COPY_FEEDBACK_DURATION_MS);
  }, [clearResetTimeout, code]);

  return { copyState, copy };
};
