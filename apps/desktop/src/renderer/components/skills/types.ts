import type { SkillContent, SkillScope, SkillSummary } from '@/shared/skills';
import type { RefObject } from 'react';

export type SkillsStatus = 'idle' | 'loading' | 'ready' | 'error';

export type SkillsStore = Readonly<{
  skills: readonly SkillSummary[];
  status: SkillsStatus;
  error: string | null;
  notice: string | null;
  workspaceAvailable: boolean;
  selectedSkill: SkillSummary | null;
  content: SkillContent | null;
  contentLoading: boolean;
  contentError: string | null;
  actionPending: boolean;
  importMenuOpen: boolean;
  detailRef: RefObject<HTMLElement | null>;
  closeButtonRef: RefObject<HTMLButtonElement | null>;
  setImportMenuOpen: (open: boolean) => void;
  refresh: () => Promise<void>;
  toggle: (skill: SkillSummary) => Promise<void>;
  openSkill: (skill: SkillSummary) => Promise<void>;
  closeSkill: () => void;
  importDirectory: (scope: SkillScope) => Promise<void>;
  importArchive: (scope: SkillScope) => Promise<void>;
  exportDirectory: (skill: SkillSummary) => Promise<void>;
  exportArchive: (skill: SkillSummary) => Promise<void>;
}>;

export type SkillsSettingsPanelProps = Readonly<{
  active: boolean;
}>;

export type SkillDocumentProps = Readonly<{
  name: string;
  description?: string;
  content: string;
}>;
