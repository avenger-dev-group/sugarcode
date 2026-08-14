import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildAgentInstructions,
  hostPlatformInstruction,
} from '../../src/runtime/agent-instructions.ts';

const mainTools = [
  'request_user_input',
  'workspace_list',
  'workspace_read',
  'workspace_search',
  'workspace_apply_patch',
  'shell_exec',
  'collaboration_dispatch',
];

test('main Agent instructions are dynamically scoped to capabilities', () => {
  const prompt = buildAgentInstructions({
    role: 'main',
    access: 'workspaceWrite',
    platform: 'darwin',
    availableTools: mainTools,
    collaborationEnabled: true,
    composerInstruction: '# Composer fixture',
    skillInstruction: '# Skill fixture',
  });

  assert.match(prompt, /explicit current request.*takes precedence/u);
  assert.match(prompt, /cannot add tools, expand permissions, bypass approval/u);
  assert.match(prompt, /workspaceInstructionsRequired/u);
  assert.match(prompt, /Main Agent mission/u);
  assert.match(prompt, /Multi-Agent coordination/u);
  assert.match(prompt, /host is macOS/u);
  assert.match(prompt, /Composer fixture/u);
  assert.match(prompt, /Skill fixture/u);
  assert.match(prompt, /\*\*\* Begin Patch/u);
  assert.match(prompt, /absolute executable and arguments are separate/u);
  assert.doesNotMatch(prompt, /Ask 1 to 3/u);
});

test('read-only role prompts expose a bounded mission without write or collaboration guidance', () => {
  const explorer = buildAgentInstructions({
    role: 'explorer',
    access: 'readOnly',
    platform: 'darwin',
    availableTools: ['workspace_list', 'workspace_read', 'workspace_search'],
    collaborationEnabled: false,
  });
  const auditor = buildAgentInstructions({
    role: 'auditor',
    access: 'readOnly',
    platform: 'darwin',
    availableTools: ['workspace_list', 'workspace_read', 'workspace_search'],
    collaborationEnabled: false,
  });

  assert.match(explorer, /read-only explorer subagent/u);
  assert.match(explorer, /Do not modify files/u);
  assert.doesNotMatch(explorer, /workspace_apply_patch/u);
  assert.doesNotMatch(explorer, /Multi-Agent coordination/u);
  assert.doesNotMatch(explorer, /Host platform/u);
  assert.match(auditor, /read-only reviewer subagent/u);
  assert.match(auditor, /high-confidence defects/u);
});

test('planning mode explicitly remains read-only after structured user input', () => {
  const prompt = buildAgentInstructions({
    role: 'main',
    access: 'readOnly',
    turnMode: 'plan',
    platform: 'darwin',
    availableTools: [
      'request_user_input',
      'submit_plan',
      'workspace_list',
      'workspace_read',
      'workspace_search',
    ],
    collaborationEnabled: false,
  });

  assert.match(prompt, /immutable planning mode/u);
  assert.match(prompt, /never authorizes implementation/u);
  assert.match(prompt, /submit it exactly once with submit_plan/u);
  assert.match(prompt, /should I proceed/u);
  assert.match(prompt, /access level is readOnly/u);
  assert.doesNotMatch(prompt, /Multi-Agent coordination/u);
  assert.doesNotMatch(prompt, /workspace_apply_patch/u);
});

test('macOS main fixed prompt stays within the V2 size budget', () => {
  const prompt = buildAgentInstructions({
    role: 'main',
    access: 'workspaceWrite',
    platform: 'darwin',
    availableTools: mainTools,
    collaborationEnabled: true,
  });
  const bytes = Buffer.byteLength(prompt, 'utf8');
  assert.ok(bytes <= 8_192, `fixed prompt is ${bytes} bytes`);
  assert.ok(Math.ceil(bytes / 3) <= 2_750, `fixed prompt estimate is ${Math.ceil(bytes / 3)} tokens`);
});

test('platform guidance is only emitted when shell_exec is available', () => {
  assert.equal(hostPlatformInstruction('darwin', []), '');
  assert.match(hostPlatformInstruction('win32'), /host is Windows/u);
  assert.doesNotMatch(hostPlatformInstruction('win32'), /cat, wc, grep/u);
  assert.match(hostPlatformInstruction('darwin'), /BSD find/u);
});
