import { useCallback, useEffect, useState } from 'react';

import { usePanelResize } from '@/renderer/hooks/use-panel-resize';
import { initializeCommandEnvironmentPreference } from '@/renderer/services/command-environment';
import { onConnectionStateChanged } from '@/renderer/services/connection';

import {
  CONTEXT_RAIL_WIDTH,
  DEFAULT_LAYOUT,
  NAVIGATOR_WIDTH,
  parseStoredLayout,
  resolveContextRailOpen,
  updateContextRailVisibility,
} from './layout-state';
import type { StoredLayout } from './layout-state';
import type { FoundationStore, Theme } from './types';

const LAYOUT_STORAGE_KEY = 'sugarcode.desktop.layout.v1';

const loadLayout = () => {
  try {
    return parseStoredLayout(localStorage.getItem(LAYOUT_STORAGE_KEY));
  } catch {
    return DEFAULT_LAYOUT;
  }
};

export const useStore = (
  contextRailScopeKey: string | null = null,
): FoundationStore => {
  const [theme, setTheme] = useState<Theme>('light');
  const [layout, setLayout] = useState<StoredLayout>(loadLayout);
  const [contextRailVisibility, setContextRailVisibility] = useState<
    ReadonlyMap<string, boolean>
  >(() => new Map());
  const isDark = theme === 'dark';
  const contextRailOpen = resolveContextRailOpen(
    contextRailVisibility,
    contextRailScopeKey,
    layout.contextRailOpen,
  );

  useEffect(() => {
    document.documentElement.classList.toggle('dark', isDark);
    return () => document.documentElement.classList.remove('dark');
  }, [isDark]);

  useEffect(() => {
    let active = true;
    const applyPreference = (): void => {
      void initializeCommandEnvironmentPreference().catch((): void => {
        // Runtime startup and restart races are retried on the next ready signal.
      });
    };
    applyPreference();
    const unsubscribe = onConnectionStateChanged((connection) => {
      if (active && connection.status === 'ready') {
        applyPreference();
      }
    });
    return () => {
      active = false;
      unsubscribe();
    };
  }, []);

  const setNavigatorWidth = useCallback((width: number): void => {
    setLayout((current) =>
      current.navigatorWidth === width
        ? current
        : { ...current, navigatorWidth: width },
    );
  }, []);
  const setContextRailWidth = useCallback((width: number): void => {
    setLayout((current) =>
      current.contextRailWidth === width
        ? current
        : { ...current, contextRailWidth: width },
    );
  }, []);
  const toggleNavigator = (): void => {
    setLayout((current) => ({
      ...current,
      navigatorOpen: !current.navigatorOpen,
    }));
  };
  const toggleContextRail = useCallback((): void => {
    if (contextRailScopeKey !== null) {
      setContextRailVisibility((current) =>
        updateContextRailVisibility(
          current,
          contextRailScopeKey,
          !resolveContextRailOpen(current, contextRailScopeKey, false),
        ),
      );
      return;
    }
    setLayout((current) => ({
      ...current,
      contextRailOpen: !current.contextRailOpen,
    }));
  }, [contextRailScopeKey]);
  const openContextRail = useCallback((): void => {
    if (contextRailScopeKey !== null) {
      setContextRailVisibility((current) =>
        updateContextRailVisibility(current, contextRailScopeKey, true),
      );
      return;
    }
    setLayout((current) =>
      current.contextRailOpen
        ? current
        : { ...current, contextRailOpen: true },
    );
  }, [contextRailScopeKey]);
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

  useEffect(() => {
    if (navigatorResize.dragging || contextRailResize.dragging) {
      return;
    }
    try {
      localStorage.setItem(LAYOUT_STORAGE_KEY, JSON.stringify(layout));
    } catch {
      // Layout persistence is best-effort and never blocks the workbench.
    }
  }, [contextRailResize.dragging, layout, navigatorResize.dragging]);

  const toggleTheme = (): void => {
    setTheme((currentTheme: Theme) =>
      currentTheme === 'dark' ? 'light' : 'dark',
    );
  };

  return {
    isDark,
    navigatorOpen: layout.navigatorOpen,
    navigatorResize,
    contextRailOpen,
    contextRailResize,
    openContextRail,
    themeLabel: isDark ? '使用浅色主题' : '使用深色主题',
    toggleNavigator,
    toggleContextRail,
    toggleTheme,
  };
};
