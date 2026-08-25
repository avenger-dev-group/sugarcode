import type {
  KeyboardEventHandler,
  PointerEventHandler,
} from 'react';

export type Theme = 'light' | 'dark';
export type AppSurface = 'workbench' | 'knowledge' | 'capabilities';

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
  navigatorOpen: boolean;
  navigatorResize: PanelResizeHandle;
  contextRailOpen: boolean;
  contextRailResize: PanelResizeHandle;
  surface: AppSurface;
  searchOpen: boolean;
  closeContextRail: () => void;
  openContextRail: () => void;
  openSearch: () => void;
  closeSearch: () => void;
  setSurface: (surface: AppSurface) => void;
  themeLabel: string;
  toggleNavigator: () => void;
  toggleContextRail: () => void;
  toggleTheme: () => void;
};
