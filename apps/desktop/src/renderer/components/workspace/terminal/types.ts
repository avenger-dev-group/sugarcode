import type { TerminalStateSnapshot } from '@/shared/terminal';
import type { WorkspaceStateSnapshot } from '@/shared/workspace';

export type TerminalWorkbenchProps = Readonly<{
  navigatorOffset: number;
}>;

export type TerminalWorkbenchStore = Readonly<{
  open: boolean;
  state: TerminalStateSnapshot;
  workspace: WorkspaceStateSnapshot;
  busy: boolean;
  error: string | null;
  setOpen: (open: boolean) => void;
  refresh: () => Promise<void>;
  acknowledge: (sequence: number) => Promise<void>;
  create: (columns: number, rows: number) => Promise<void>;
  input: (data: string) => Promise<void>;
  resize: (columns: number, rows: number) => Promise<void>;
  terminate: () => Promise<void>;
}>;
