import type {
  SkillContent,
  SkillScope,
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

export const importSkill = (scope: SkillScope): Promise<SkillsActionResult> =>
  window.sugarcode.importSkill(scope);

export const exportSkill = (id: string): Promise<SkillsActionResult> =>
  window.sugarcode.exportSkill(id);
