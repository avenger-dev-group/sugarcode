import type {
  KeyboardEventHandler,
  PointerEventHandler,
} from 'react';

export type Theme = 'light' | 'dark';

export type PanelResizeHandle = Readonly<{
  dragging: boolean;
  minWidth: number;
  maxWidth: number;
  width: number;
  onPointerDown: PointerEventHandler<HTMLDivElement>;
  onKeyDown: KeyboardEventHandler<HTMLDivElement>;
}>;

export type FoundationStore = {
  isDark: boolean;
  navigatorResize: PanelResizeHandle;
  contextRailResize: PanelResizeHandle;
  themeLabel: string;
  toggleTheme: () => void;
};
