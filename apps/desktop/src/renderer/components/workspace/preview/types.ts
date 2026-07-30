import type { PreviewStateSnapshot } from '@/shared/preview';
import type { WorkspaceStateSnapshot } from '@/shared/workspace';

export type PreviewWorkbenchStore = Readonly<{
  open: boolean;
  url: string;
  state: PreviewStateSnapshot;
  workspace: WorkspaceStateSnapshot;
  busy: boolean;
  error: string | null;
  setOpen: (open: boolean) => void;
  setUrl: (url: string) => void;
  openLocalPreview: () => Promise<void>;
  show: () => Promise<void>;
  reload: () => Promise<void>;
  goBack: () => Promise<void>;
  goForward: () => Promise<void>;
  close: () => Promise<void>;
}>;
