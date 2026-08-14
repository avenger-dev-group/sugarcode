import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

import { RuntimeHost } from '../src/runtime/host.ts';

const desktopRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const nativeModulePath = path.join(
  desktopRoot,
  'native',
  'sugarcode-desktop-native.node',
);
const providerName = process.argv.includes('--anthropic') ? 'anthropic' : 'openai';
const apiKey = providerName === 'anthropic'
  ? process.env.ANTHROPIC_API_KEY
  : process.env.OPENAI_API_KEY;
if (!apiKey) {
  throw new Error(
    providerName === 'anthropic'
      ? 'Set ANTHROPIC_API_KEY before running the Agent V2 replay.'
      : 'Set OPENAI_API_KEY before running the Agent V2 replay.',
  );
}
if (!existsSync(nativeModulePath)) {
  throw new Error('Build the Native runtime first with `pnpm build:native:dev`.');
}

const model = providerName === 'anthropic'
  ? process.env.SUGARCODE_REPLAY_ANTHROPIC_MODEL ?? 'claude-sonnet-4-5'
  : process.env.SUGARCODE_REPLAY_OPENAI_MODEL ?? 'gpt-5.1-codex';
const provider = providerName === 'anthropic'
  ? {
      wireApi: 'anthropicMessages',
      model,
      baseUrl: 'https://api.anthropic.com',
      apiKey,
      timeoutMs: 180_000,
      parallelTools: true,
    }
  : {
      wireApi: 'openaiResponses',
      model,
      baseUrl: 'https://api.openai.com/v1',
      apiKey,
      timeoutMs: 180_000,
      parallelTools: true,
    };

const sha256 = (value) => createHash('sha256').update(value).digest('hex');
const read = (root, relative) => readFileSync(path.join(root, relative), 'utf8');
const treeSnapshot = (root) => {
  const files = [];
  const visit = (directory, relativeDirectory = '') => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const relative = path.join(relativeDirectory, entry.name);
      const absolute = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        visit(absolute, relative);
      } else if (entry.isFile()) {
        files.push([relative, sha256(readFileSync(absolute))]);
      }
    }
  };
  visit(root);
  return files.sort(([left], [right]) => left.localeCompare(right));
};
const write = (root, relative, content) => {
  const target = path.join(root, relative);
  mkdirSync(path.dirname(target), { recursive: true });
  writeFileSync(target, content);
};
const git = (root, args) => {
  const result = spawnSync('git', args, { cwd: root, encoding: 'utf8' });
  if (result.status !== 0) {
    throw new Error(result.stderr || `git ${args.join(' ')} failed`);
  }
};

const scenarios = [
  {
    name: 'plan-no-write',
    setup: (root) => {
      write(root, 'src/value.ts', 'export const value = 1;\n');
      write(root, 'AGENTS.md', 'Keep plans concise and evidence-based.\n');
    },
    prompt:
      '/plan Design a change that makes src/value.ts export 2. Ask a question if useful, but do not implement it.',
    verify: (root, _before, events, beforeTree) => {
      assert.deepEqual(treeSnapshot(root), beforeTree);
      assert.equal(events.some((event) =>
        event.type === 'turn.toolCall' && [
          'workspace_apply_patch',
          'shell_exec',
          'collaboration_dispatch',
        ].includes(event.name)
      ), false);
      assert.equal(
        events.filter((event) => event.type === 'approval.requested').length,
        0,
      );
    },
  },
  {
    name: 'explain-no-write',
    setup: (root) => write(root, 'src/value.ts', 'export const value = 1;\n'),
    prompt: '/explain Explain the behavior of src/value.ts with evidence. Do not modify files.',
    verify: (root, _before, events, beforeTree) => {
      assert.deepEqual(treeSnapshot(root), beforeTree);
      assert.equal(events.some((event) =>
        event.type === 'turn.toolCall' && event.name === 'workspace_apply_patch'
      ), false);
    },
  },
  {
    name: 'fix-and-verify',
    setup: (root) => {
      write(root, 'src/value.ts', 'export const value = 1;\n');
      write(root, 'package.json', '{"scripts":{"test":"node -e \\\"process.exit(require(\\\'fs\\\').readFileSync(\\\'src/value.ts\\\',\\\'utf8\\\').includes(\\\'= 2\\\')?0:1)\\\"}}\n');
    },
    prompt: '/fix Change src/value.ts so value is 2 and run the relevant test.',
    verify: (root) => assert.match(read(root, 'src/value.ts'), /value = 2/u),
  },
  {
    name: 'dirty-worktree-preserved',
    setup: (root) => {
      write(root, 'src/value.ts', 'export const value = 1;\n');
      write(root, 'notes.txt', 'committed\n');
      git(root, ['init', '-q']);
      git(root, ['config', 'user.email', 'replay@example.invalid']);
      git(root, ['config', 'user.name', 'SugarCode Replay']);
      git(root, ['add', '.']);
      git(root, ['commit', '-qm', 'fixture']);
      write(root, 'notes.txt', 'user draft - preserve exactly\n');
    },
    prompt: '/fix Change only src/value.ts so value is 3. Preserve unrelated dirty work.',
    verify: (root) => {
      assert.match(read(root, 'src/value.ts'), /value = 3/u);
      assert.equal(read(root, 'notes.txt'), 'user draft - preserve exactly\n');
    },
  },
  {
    name: 'nested-rules',
    setup: (root) => {
      write(root, 'AGENTS.md', 'Keep changes minimal.\n');
      write(root, 'src/CLAUDE.md', 'When changing files in this scope, add the comment // nested-rule-observed.\n');
      write(root, 'src/value.ts', 'export const value = 1;\n');
    },
    prompt: '/fix Change src/value.ts so value is 4 while following project instructions.',
    verify: (root) => assert.match(read(root, 'src/value.ts'), /nested-rule-observed/u),
  },
  {
    name: 'invalid-rules-block-write',
    setup: (root) => {
      writeFileSync(path.join(root, 'AGENTS.override.md'), Buffer.from('bad\0rules'));
      write(root, 'AGENTS.md', 'This lower-priority fallback must not be used.\n');
      write(root, 'src/value.ts', 'export const value = 1;\n');
    },
    prompt: '/fix Change src/value.ts so value is 5.',
    verify: (root, before, events) => {
      assert.equal(sha256(read(root, 'src/value.ts')), before.get('src/value.ts'));
      assert.ok(events.some((event) =>
        event.type === 'turn.toolResult' &&
        JSON.stringify(event.result).includes('workspaceInstructionsUnavailable')
      ));
    },
  },
  {
    name: 'compaction-keeps-rules',
    extended: true,
    setup: (root) => {
      write(root, 'AGENTS.md', 'Every modified TypeScript file must include // compaction-rule-observed.\n');
      write(root, 'src/value.ts', 'export const value = 1;\n');
    },
    prompt: `${'Preserve this context. '.repeat(2_000)}\n\n/fix Change src/value.ts so value is 6.`,
    provider: { compactThresholdTokens: 2_000 },
    verify: (root, _before, events) => {
      assert.match(read(root, 'src/value.ts'), /compaction-rule-observed/u);
      assert.ok(events.some((event) => event.type === 'turn.contextCompactionFinished'));
    },
  },
  {
    name: 'reviewer-confidence',
    setup: (root) => write(root, 'src/value.ts', 'export const value = 1;\n'),
    prompt:
      'Use collaboration: ask one worker to change src/value.ts so value is 7 and let the reviewer audit it. Finish only after collecting the audit.',
    verify: (root, _before, events) => {
      assert.match(read(root, 'src/value.ts'), /value = 7/u);
      assert.ok(events.some((event) =>
        event.type === 'agent.task' && event.task.role === 'auditor' &&
        event.task.status === 'completed'
      ));
    },
  },
  {
    name: 'tool-argument-recovery',
    setup: (root) => write(root, 'src/value.ts', 'export const value = 1;\n'),
    prompt:
      'Inspect src/value.ts, then change value to 8. If any tool argument is rejected, repair it and continue without looping.',
    verify: (root, _before, events) => {
      assert.match(read(root, 'src/value.ts'), /value = 8/u);
      const calls = events.filter((event) => event.type === 'turn.toolCall').length;
      assert.ok(calls < 20, `tool call loop detected (${calls})`);
    },
  },
];

const extended = process.env.SUGARCODE_REPLAY_EXTENDED === '1';
const replayRoot = mkdtempSync(path.join(tmpdir(), 'sugarcode-agent-v2-replay-'));
const results = [];
try {
  for (const scenario of scenarios) {
    if (scenario.extended && !extended) continue;
    const scenarioRoot = path.join(replayRoot, scenario.name);
    const dataDirectory = path.join(replayRoot, `data-${scenario.name}`);
    mkdirSync(scenarioRoot, { recursive: true });
    mkdirSync(dataDirectory, { recursive: true });
    scenario.setup(scenarioRoot);
    const beforeTree = treeSnapshot(scenarioRoot);
    const before = new Map();
    for (const relative of ['src/value.ts', 'notes.txt']) {
      if (existsSync(path.join(scenarioRoot, relative))) {
        before.set(relative, sha256(read(scenarioRoot, relative)));
      }
    }
    const events = [];
    const workspaceId = randomUUID();
    const threadId = randomUUID();
    const turnId = randomUUID();
    let resolveCompleted;
    const completed = new Promise((resolve) => { resolveCompleted = resolve; });
    const host = new RuntimeHost({
      postEvent: (event) => {
        events.push(event);
        if (event.type === 'approval.requested') {
          host.handle({
            type: 'approval.resolve',
            requestId: randomUUID(),
            workspaceId,
            threadId,
            turnId,
            approvalId: event.approvalId,
            decision: 'approved',
            source: 'user',
          });
        }
        if (event.type === 'turn.userInputRequested') {
          host.handle({
            type: 'turn.userInputResponse',
            requestId: randomUUID(),
            workspaceId,
            threadId,
            turnId,
            inputRequestId: event.inputRequestId,
            submission: {
              kind: 'submitted',
              decisions: event.questions.map((question) => ({
                questionId: question.id,
                kind: 'answered',
                source: 'option',
                answer: question.options[0]?.label ?? '',
              })),
            },
          });
        }
        if (event.type === 'turn.completed') resolveCompleted(event);
      },
    });
    const startedAt = Date.now();
    host.handle({
      type: 'initialize',
      requestId: randomUUID(),
      protocolVersion: 4,
      dataDirectory,
      nativeModulePath,
    });
    host.handle({
      type: 'workspace.open',
      requestId: randomUUID(),
      workspaceId,
      canonicalRoot: scenarioRoot,
    });
    host.handle({
      type: 'turn.start',
      requestId: randomUUID(),
      workspaceId,
      threadId,
      turnId,
      provider: { ...provider, ...scenario.provider },
      content: [{ type: 'text', text: scenario.prompt }],
    });
    const terminal = await Promise.race([
      completed,
      new Promise((_, reject) => setTimeout(
        () => reject(new Error(`${scenario.name} timed out`)),
        10 * 60_000,
      )),
    ]);
    let error;
    try {
      assert.equal(terminal.status, 'completed');
      scenario.verify(scenarioRoot, before, events, beforeTree);
    } catch (failure) {
      error = failure instanceof Error ? failure.message : String(failure);
    }
    const usage = events.filter((event) => event.type === 'turn.usage')
      .map((event) => event.usage)
      .at(-1);
    results.push({
      scenario: scenario.name,
      ok: !error,
      error,
      toolCalls: events.filter((event) => event.type === 'turn.toolCall').length,
      approvals: events.filter((event) => event.type === 'approval.requested').length,
      inputTokens: usage?.inputTokens ?? 0,
      latencyMs: Date.now() - startedAt,
    });
  }
} finally {
  if (replayRoot.startsWith(`${tmpdir()}${path.sep}sugarcode-agent-v2-replay-`)) {
    rmSync(replayRoot, { recursive: true, force: true });
  }
}

console.table(results);
if (results.some((result) => !result.ok)) process.exitCode = 1;
