import type { RefObject, UIEvent } from 'react';

import type {
  ConversationPhase,
  ConversationTurnError,
  ConversationTurnStatus,
} from '@/shared/conversation';

import type {
  AgentMessageViewModel,
  WorkspaceReadActivityViewModel,
} from '../agent/types';

export type UserMessageViewModel = Readonly<{
  id: string;
  text: string;
}>;

export type TranscriptMessageViewModel =
  | Readonly<{
      role: 'user';
      message: UserMessageViewModel;
    }>
  | Readonly<{
      role: 'agent';
      message: AgentMessageViewModel;
    }>;

export type TurnFailureViewModel = Readonly<{
  kind: ConversationTurnError['kind'];
  summary: string;
  guidance: string;
  retryable: boolean;
}>;

export type TurnViewModel = Readonly<{
  id: string;
  status: ConversationTurnStatus;
  messages: readonly TranscriptMessageViewModel[];
  workspaceRead?: WorkspaceReadActivityViewModel;
  terminalLabel?: string;
  failure?: TurnFailureViewModel;
  isError: boolean;
}>;

export type ThreadViewModel = Readonly<{
  phase: ConversationPhase;
  threadIdentity: string | null;
  turns: readonly TurnViewModel[];
  isEmpty: boolean;
  statusLabel: string;
  notice?: string;
}>;

export type ThreadStore = Readonly<{
  thread: ThreadViewModel;
  draft: string;
  inputBytes: number;
  inputLimitBytes: number;
  inputHint: string;
  canSend: boolean;
  canStop: boolean;
  isSending: boolean;
  actionError: string | null;
  setDraft: (value: string) => void;
  send: () => Promise<void>;
  stop: () => Promise<void>;
}>;

export type ThreadWorkbenchViewProps = Readonly<{
  store: ThreadStore;
}>;

export type TranscriptTurnProps = Readonly<{
  turn: TurnViewModel;
}>;

export type TranscriptFollow = Readonly<{
  transcriptEnd: RefObject<HTMLDivElement | null>;
  recordScrollPosition: (event: UIEvent<HTMLDivElement>) => void;
}>;
