import { useEffect, useState } from 'react';

import type { FoundationStore, Theme } from './types';

export const useStore = (): FoundationStore => {
  const [theme, setTheme] = useState<Theme>('light');
  const isDark = theme === 'dark';

  useEffect(() => {
    document.documentElement.classList.toggle('dark', isDark);
    return () => document.documentElement.classList.remove('dark');
  }, [isDark]);

  const toggleTheme = (): void => {
    setTheme((currentTheme: Theme) =>
      currentTheme === 'dark' ? 'light' : 'dark',
    );
  };

  return {
    isDark,
    themeLabel: isDark ? 'Use light theme' : 'Use dark theme',
    toggleTheme,
  };
};
