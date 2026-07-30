export type Theme = 'light' | 'dark';

export type FoundationStore = {
  isDark: boolean;
  contextRailOpen: boolean;
  themeLabel: string;
  setContextRailOpen: (open: boolean) => void;
  toggleTheme: () => void;
};
