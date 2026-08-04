import { useEffect, useState } from 'react';

import { usePanelResize } from '@/renderer/hooks/use-panel-resize';

import type { FoundationStore, Theme } from './types';

const LAYOUT_STORAGE_KEY = 'sugarcode.desktop.layout.v1';
const NAVIGATOR_WIDTH = { default: 286, min: 240, max: 380 } as const;
const CONTEXT_RAIL_WIDTH = { default: 760, min: 380, max: 1200 } as const;

type StoredLayout = Readonly<{
  navigatorWidth: number;
  navigatorOpen: boolean;
  contextRailWidth: number;
  contextRailOpen: boolean;
}>;

const validWidth = (
  value: unknown,
  range: typeof NAVIGATOR_WIDTH | typeof CONTEXT_RAIL_WIDTH,
): number =>
  typeof value === 'number' &&
  Number.isFinite(value) &&
  value >= range.min &&
  value <= range.max
    ? value
    : range.default;

const validOpen = (value: unknown): boolean =>
  typeof value === 'boolean' ? value : true;

const loadLayout = (): StoredLayout => {
  try {
    const value: unknown = JSON.parse(
      localStorage.getItem(LAYOUT_STORAGE_KEY) ?? 'null',
    );
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      throw new Error('No stored layout.');
    }
    const candidate = value as Partial<StoredLayout>;
    return {
      navigatorWidth: validWidth(candidate.navigatorWidth, NAVIGATOR_WIDTH),
      navigatorOpen: validOpen(candidate.navigatorOpen),
      contextRailWidth: validWidth(
        candidate.contextRailWidth,
        CONTEXT_RAIL_WIDTH,
      ),
      contextRailOpen: validOpen(candidate.contextRailOpen),
    };
  } catch {
    return {
      navigatorWidth: NAVIGATOR_WIDTH.default,
      navigatorOpen: true,
      contextRailWidth: CONTEXT_RAIL_WIDTH.default,
      contextRailOpen: true,
    };
  }
};

export const useStore = (): FoundationStore => {
  const [theme, setTheme] = useState<Theme>('light');
  const [layout, setLayout] = useState<StoredLayout>(loadLayout);
  const isDark = theme === 'dark';

  useEffect(() => {
    document.documentElement.classList.toggle('dark', isDark);
    return () => document.documentElement.classList.remove('dark');
  }, [isDark]);

  useEffect(() => {
    try {
      localStorage.setItem(LAYOUT_STORAGE_KEY, JSON.stringify(layout));
    } catch {
      // Layout persistence is best-effort and never blocks the workbench.
    }
  }, [layout]);

  const setNavigatorWidth = (width: number): void => {
    setLayout((current) => ({ ...current, navigatorWidth: width }));
  };
  const setContextRailWidth = (width: number): void => {
    setLayout((current) => ({ ...current, contextRailWidth: width }));
  };
  const toggleNavigator = (): void => {
    setLayout((current) => ({
      ...current,
      navigatorOpen: !current.navigatorOpen,
    }));
  };
  const toggleContextRail = (): void => {
    setLayout((current) => ({
      ...current,
      contextRailOpen: !current.contextRailOpen,
    }));
  };
  const openContextRail = (): void => {
    setLayout((current) =>
      current.contextRailOpen
        ? current
        : { ...current, contextRailOpen: true },
    );
  };
  const navigatorResize = usePanelResize({
    width: layout.navigatorWidth,
    minWidth: NAVIGATOR_WIDTH.min,
    maxWidth: NAVIGATOR_WIDTH.max,
    onResize: setNavigatorWidth,
  });
  const contextRailResize = usePanelResize({
    width: layout.contextRailWidth,
    minWidth: CONTEXT_RAIL_WIDTH.min,
    maxWidth: CONTEXT_RAIL_WIDTH.max,
    reverse: true,
    onResize: setContextRailWidth,
  });

  const toggleTheme = (): void => {
    setTheme((currentTheme: Theme) =>
      currentTheme === 'dark' ? 'light' : 'dark',
    );
  };

  return {
    isDark,
    navigatorOpen: layout.navigatorOpen,
    navigatorResize,
    contextRailOpen: layout.contextRailOpen,
    contextRailResize,
    openContextRail,
    themeLabel: isDark ? 'Use light theme' : 'Use dark theme',
    toggleNavigator,
    toggleContextRail,
    toggleTheme,
  };
};
