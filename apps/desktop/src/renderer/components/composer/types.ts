import type {
  ChangeEvent,
  ClipboardEvent,
  KeyboardEvent,
  RefObject,
  UIEvent,
} from 'react';

export type ComposerTrigger = '/' | '$' | '@';

export type ComposerToken = Readonly<{
  trigger: ComposerTrigger;
  start: number;
  end: number;
  query: string;
}>;

export type ComposerSuggestion = Readonly<{
  id: string;
  kind: 'application' | 'command' | 'skill' | 'knowledge' | 'file';
  label: string;
  alias?: string;
  brand?: 'figma';
  description: string;
  detail?: string;
  insertion: string;
}>;

export type ComposerDisplaySegment = Readonly<{
  kind:
    | 'text'
    | 'application'
    | 'command'
    | 'skill'
    | 'knowledge'
    | 'link'
    | 'file';
  text: string;
}>;

export type ComposerSuggestionStatus =
  | 'idle'
  | 'loading'
  | 'ready'
  | 'error';

export type ComposerInputProps = Readonly<{
  value: string;
  disabled: boolean;
  workspaceGeneration: number;
  workspaceReady: boolean;
  onValueChange: (value: string) => void;
  onPaste: (event: ClipboardEvent<HTMLTextAreaElement>) => void;
  onSubmit: () => void;
}>;

export type ComposerSuggestionStore = Readonly<{
  textareaRef: RefObject<HTMLTextAreaElement | null>;
  mirrorRef: RefObject<HTMLDivElement | null>;
  token: ComposerToken | null;
  suggestions: readonly ComposerSuggestion[];
  activeIndex: number;
  status: ComposerSuggestionStatus;
  message: string | null;
  listboxId: string;
  handleChange: (event: ChangeEvent<HTMLTextAreaElement>) => void;
  handleKeyDown: (event: KeyboardEvent<HTMLTextAreaElement>) => void;
  handleScroll: (event: UIEvent<HTMLTextAreaElement>) => void;
  choose: (suggestion: ComposerSuggestion) => void;
  setActiveIndex: (index: number) => void;
  close: () => void;
}>;
