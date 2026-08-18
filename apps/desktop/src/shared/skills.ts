export const SKILLS_GET_CHANNEL = 'skills:get';
export const SKILLS_CONTENT_CHANNEL = 'skills:content';
export const SKILLS_SET_ENABLED_CHANNEL = 'skills:set-enabled';
export const SKILLS_IMPORT_CHANNEL = 'skills:import';
export const SKILLS_EXPORT_CHANNEL = 'skills:export';
export const SKILLS_IMPORT_ZIP_CHANNEL = 'skills:import-zip';
export const SKILLS_EXPORT_ZIP_CHANNEL = 'skills:export-zip';

export type SkillScope = 'user' | 'project';
export type SkillSource = 'user' | 'project';

export type SkillSummary = Readonly<{
  id: string;
  name: string;
  description: string;
  source: SkillSource;
  path: string;
  sha256: string;
  bytes: number;
  enabled: boolean;
}>;

export type SkillsInspection = Readonly<{
  skills: readonly SkillSummary[];
  workspaceAvailable: boolean;
}>;

export type SkillContent = Readonly<{
  skill: SkillSummary;
  content: string;
}>;

export type SkillsActionResult =
  | Readonly<{
      accepted: true;
      inspection?: SkillsInspection;
      path?: string;
    }>
  | Readonly<{
      accepted: false;
      reason: 'cancelled' | 'invalid' | 'unavailable' | 'conflict';
      message?: string;
    }>;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

export const isSkillId = (value: unknown): value is string =>
  typeof value === 'string' && /^skl_[0-9a-f]{64}$/u.test(value);

export const isSkillSummary = (value: unknown): value is SkillSummary =>
  isRecord(value) &&
  isSkillId(value.id) &&
  typeof value.name === 'string' &&
  /^[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(value.name) &&
  typeof value.description === 'string' &&
  value.description.length <= 1_024 &&
  (value.source === 'user' || value.source === 'project') &&
  typeof value.path === 'string' &&
  value.path.length > 0 &&
  value.path.length <= 2_048 &&
  typeof value.sha256 === 'string' &&
  /^[0-9a-f]{64}$/u.test(value.sha256) &&
  Number.isSafeInteger(value.bytes) &&
  Number(value.bytes) > 0 &&
  Number(value.bytes) <= 32 * 1_024 &&
  typeof value.enabled === 'boolean';

export const isSkillsInspection = (value: unknown): value is SkillsInspection =>
  isRecord(value) &&
  Array.isArray(value.skills) &&
  value.skills.length <= 64 &&
  value.skills.every(isSkillSummary) &&
  typeof value.workspaceAvailable === 'boolean';

export const isSkillContent = (value: unknown): value is SkillContent =>
  isRecord(value) &&
  isSkillSummary(value.skill) &&
  typeof value.content === 'string' &&
  new TextEncoder().encode(value.content).byteLength === value.skill.bytes;

export const isSkillsActionResult = (
  value: unknown,
): value is SkillsActionResult => {
  if (!isRecord(value) || typeof value.accepted !== 'boolean') {
    return false;
  }
  if (!value.accepted) {
    return (
      ['cancelled', 'invalid', 'unavailable', 'conflict'].includes(
        String(value.reason),
      ) &&
      (value.message === undefined || typeof value.message === 'string')
    );
  }
  return (
    (value.inspection === undefined || isSkillsInspection(value.inspection)) &&
    (value.path === undefined || typeof value.path === 'string')
  );
};

export type SkillsApi = Readonly<{
  getSkills: () => Promise<SkillsInspection>;
  getSkillContent: (
    id: string,
    expectedSha256: string,
  ) => Promise<SkillContent>;
  setSkillEnabled: (
    id: string,
    enabled: boolean,
  ) => Promise<SkillsActionResult>;
  importSkill: (scope: SkillScope) => Promise<SkillsActionResult>;
  exportSkill: (id: string) => Promise<SkillsActionResult>;
  importSkillZip: (scope: SkillScope) => Promise<SkillsActionResult>;
  exportSkillZip: (id: string) => Promise<SkillsActionResult>;
  installCuratedSkill: (catalogId: string) => Promise<SkillsActionResult>;
}>;
