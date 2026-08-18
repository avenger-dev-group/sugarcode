import type {
  SkillContent,
  SkillsActionResult,
  SkillsInspection,
} from '@/shared/skills';

export const getSkills = (): Promise<SkillsInspection> =>
  window.sugarcode.getSkills();

export const getSkillContent = (
  id: string,
  expectedSha256: string,
): Promise<SkillContent> =>
  window.sugarcode.getSkillContent(id, expectedSha256);

export const setSkillEnabled = (
  id: string,
  enabled: boolean,
): Promise<SkillsActionResult> => window.sugarcode.setSkillEnabled(id, enabled);

export const importSkill = (): Promise<SkillsActionResult> =>
  window.sugarcode.importSkill();

export const exportSkill = (id: string): Promise<SkillsActionResult> =>
  window.sugarcode.exportSkill(id);

export const importSkillZip = (): Promise<SkillsActionResult> =>
  window.sugarcode.importSkillZip();

export const exportSkillZip = (id: string): Promise<SkillsActionResult> =>
  window.sugarcode.exportSkillZip(id);
