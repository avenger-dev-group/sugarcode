import { useCopyText } from '@/renderer/components/message-actions/use-copy-text';

import type { CodeBlockStore } from './types';

export const useStore = (code: string): CodeBlockStore => {
  const { copy, state } = useCopyText(code);
  return { copyState: state, copy };
};
