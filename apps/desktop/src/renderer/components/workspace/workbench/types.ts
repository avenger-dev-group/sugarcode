import type {
  WorkspaceEntry,
  WorkspaceInspectDocument,
  WorkspaceStateSnapshot,
} from '@/shared/workspace';

export type WorkspaceWorkbenchStore = Readonly<{
  open: boolean;
  state: WorkspaceStateSnapshot;
  entries: ReadonlyMap<string, readonly WorkspaceEntry[]>;
  expanded: ReadonlySet<string>;
  loading: ReadonlySet<string>;
  selectedPath: string | null;
  document: WorkspaceInspectDocument | null;
  error: string | null;
  setOpen: (open: boolean) => void;
  chooseWorkspace: () => Promise<void>;
  toggleDirectory: (path: string) => Promise<void>;
  openFile: (path: string) => Promise<void>;
  refresh: () => Promise<void>;
}>;
