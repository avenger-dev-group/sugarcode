export const SKILLS_MARKET_INSTALL_CHANNEL = 'skills-market:install';

export type CuratedSkill = Readonly<{
  id: string;
  name: string;
  description: string;
  category: 'engineering-quality';
  author: string;
  license: string;
  version: string;
  minimumAppVersion: string;
  repository: string;
  commit: string;
  path: string;
  directorySha256: string;
  skillSha256: string;
}>;

const OPENAI_PLUGINS_COMMIT = '11c74d6ba24d3a6d48f54a194cd00ef3beea18f9';

export const CURATED_SKILLS: readonly CuratedSkill[] = [
  {
    id: 'openai-verification-before-completion',
    name: 'verification-before-completion',
    description: '在宣称完成前运行验证并核对真实输出，避免用推测代替证据。',
    category: 'engineering-quality',
    author: 'OpenAI / Superpowers',
    license: 'MIT',
    version: '2026.08.17',
    minimumAppVersion: '3.3.2',
    repository: 'https://github.com/openai/plugins.git',
    commit: OPENAI_PLUGINS_COMMIT,
    path: 'plugins/superpowers/skills/verification-before-completion',
    directorySha256: 'd503a317e4b4bc6ffc6a667b74e29cf7d745b47a31d706a7da4454c8c5960b59',
    skillSha256: 'ea52d15aabaf72bc6b558efe2c126f161b53961090ddcd712000273bfe8c7b6c',
  },
  {
    id: 'openai-test-driven-development',
    name: 'test-driven-development',
    description: '在实现功能或修复缺陷前建立失败测试，并以最小改动推动测试通过。',
    category: 'engineering-quality',
    author: 'OpenAI / Superpowers',
    license: 'MIT',
    version: '2026.08.17',
    minimumAppVersion: '3.3.2',
    repository: 'https://github.com/openai/plugins.git',
    commit: OPENAI_PLUGINS_COMMIT,
    path: 'plugins/superpowers/skills/test-driven-development',
    directorySha256: '8e41d965878925b2b948ce3c96513dc4421aa3d75ccfd0b372f1e22286670943',
    skillSha256: '7dee67b4af6bdccc7a914ca34533184d64592d0f5b23aeae631538168db14994',
  },
  {
    id: 'openai-receiving-code-review',
    name: 'receiving-code-review',
    description: '以技术验证处理代码审查意见，在反馈含糊或可疑时先核实再修改。',
    category: 'engineering-quality',
    author: 'OpenAI / Superpowers',
    license: 'MIT',
    version: '2026.08.17',
    minimumAppVersion: '3.3.2',
    repository: 'https://github.com/openai/plugins.git',
    commit: OPENAI_PLUGINS_COMMIT,
    path: 'plugins/superpowers/skills/receiving-code-review',
    directorySha256: '48c3c6b9f65cb96fcf2a202b710bb364a6008c2d9f45922f92c6564e1927ab49',
    skillSha256: 'c9382e92b8f32363566068ecfed19d3b2651eaf40d3942b24840f839dedfc406',
  },
];
