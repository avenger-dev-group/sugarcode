import type { TranscriptTurnProps } from './types';

export const toTranscriptTurnBoundary = (
  turnIndex: number,
  precedingTurnHasTerminalBoundary: boolean,
): TranscriptTurnProps['boundary'] => {
  if (turnIndex === 0) {
    return 'none';
  }
  return precedingTurnHasTerminalBoundary ? 'precedingTerminal' : 'divider';
};
