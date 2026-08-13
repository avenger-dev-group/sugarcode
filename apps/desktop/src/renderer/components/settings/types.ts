export type SettingsSection = 'general' | 'model' | 'skills' | 'about';

export type SettingsStore = Readonly<{
  open: boolean;
  section: SettingsSection;
  setOpen: (open: boolean) => void;
  setSection: (section: SettingsSection) => void;
}>;

export type SettingsDialogProps = Readonly<{
  isDark: boolean;
  themeLabel: string;
  toggleTheme: () => void;
}>;
