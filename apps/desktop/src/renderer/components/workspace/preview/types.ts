import type { PreviewBounds, PreviewStateSnapshot } from '@/shared/preview';
import type { WorkspaceStateSnapshot } from '@/shared/workspace';

export type PreviewWorkbenchStore = Readonly<{
  url: string;
  state: PreviewStateSnapshot;
  workspace: WorkspaceStateSnapshot;
  busy: boolean;
  error: string | null;
  setUrl: (url: string) => void;
  navigate: () => Promise<void>;
  setBounds: (bounds: PreviewBounds | null) => Promise<void>;
  reload: () => Promise<void>;
  goBack: () => Promise<void>;
  goForward: () => Promise<void>;
  close: () => Promise<void>;
}>;
