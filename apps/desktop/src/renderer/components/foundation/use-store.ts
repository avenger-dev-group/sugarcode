import { useCallback, useEffect, useState } from 'react';

import { usePanelResize } from '@/renderer/hooks/use-panel-resize';
import { initializeCommandEnvironmentPreference } from '@/renderer/services/command-environment';
import { onConnectionStateChanged } from '@/renderer/services/connection';

import {
  CONTEXT_RAIL_WIDTH,
  DEFAULT_LAYOUT,
  NAVIGATOR_WIDTH,
  parseStoredLayout,
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

export const useStore = (): FoundationStore => {
  const [theme, setTheme] = useState<Theme>('light');
  const [layout, setLayout] = useState<StoredLayout>(loadLayout);
  const isDark = theme === 'dark';

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
    contextRailOpen: layout.contextRailOpen,
    contextRailResize,
    openContextRail,
    themeLabel: isDark ? 'Use light theme' : 'Use dark theme',
    toggleNavigator,
    toggleContextRail,
    toggleTheme,
  };
};
