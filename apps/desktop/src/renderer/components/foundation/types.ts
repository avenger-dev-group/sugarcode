export type Theme = 'light' | 'dark';

export type FoundationStore = {
  isDark: boolean;
  themeLabel: string;
  toggleTheme: () => void;
};
