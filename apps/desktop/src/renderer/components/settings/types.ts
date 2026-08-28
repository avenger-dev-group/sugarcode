export type SettingsSection = 'general' | 'model' | 'experimental' | 'about';

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
  workspaceId?: string;
  threadId?: string;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
}>;
