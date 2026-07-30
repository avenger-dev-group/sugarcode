import { useState } from 'react';

import type { SettingsSection, SettingsStore } from './types';

export const useStore = (): SettingsStore => {
  const [open, setOpen] = useState<boolean>(false);
  const [section, setSection] = useState<SettingsSection>('general');

  return {
    open,
    section,
    setOpen,
    setSection,
  };
};
