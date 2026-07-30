import type {
  TerminalActionResult,
  TerminalCreateRequest,
  TerminalInputRequest,
  TerminalResizeRequest,
  TerminalSessionRequest,
  TerminalSnapshotRequest,
  TerminalStateSignal,
  TerminalStateSnapshot,
} from '@/shared/terminal';

export const getTerminalSnapshot = (
  request: TerminalSnapshotRequest,
): Promise<TerminalStateSnapshot> =>
  window.sugarcode.getTerminalSnapshot(request);

export const onTerminalStateChanged = (
  listener: (signal: TerminalStateSignal) => void,
): (() => void) => window.sugarcode.onTerminalStateChanged(listener);

export const createTerminal = (
  request: TerminalCreateRequest,
): Promise<TerminalActionResult> =>
  window.sugarcode.createTerminal(request);

export const writeTerminalInput = (
  request: TerminalInputRequest,
): Promise<TerminalActionResult> =>
  window.sugarcode.writeTerminalInput(request);

export const resizeTerminal = (
  request: TerminalResizeRequest,
): Promise<TerminalActionResult> =>
  window.sugarcode.resizeTerminal(request);

export const terminateTerminal = (
  request: TerminalSessionRequest,
): Promise<TerminalActionResult> =>
  window.sugarcode.terminateTerminal(request);
