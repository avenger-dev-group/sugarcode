import assert from 'node:assert/strict';
import test from 'node:test';

import {
  isRuntimeCommand,
  isRuntimeEvent,
} from '../../src/runtime/protocol.ts';

test('private runtime validates shared semantic model lifecycle commands', () => {
  for (const type of [
    'knowledge.model.install',
    'knowledge.model.cancel',
    'knowledge.model.remove',
  ] as const) {
    assert.equal(
      isRuntimeCommand({ type, requestId: `request-${type}` }),
      true,
    );
  }
  assert.equal(
    isRuntimeCommand({
      type: 'knowledge.retrieval.select',
      requestId: 'request-retrieval-select',
      planId: 'BAAI/bge-small-zh-v1.5',
    }),
    true,
  );
  assert.equal(
    isRuntimeCommand({
      type: 'knowledge.retrieval.select',
      requestId: 'request-retrieval-empty',
      planId: '',
    }),
    false,
  );
  assert.equal(
    isRuntimeCommand({
      type: 'knowledge.semanticIndex.pause',
      requestId: 'request-index-pause',
      paused: true,
    }),
    true,
  );
});

test('private runtime validates knowledge source maintenance commands', () => {
  const knowledgeBaseId = `kb_${'1'.repeat(32)}`;
  const sourceId = `ks_${'2'.repeat(32)}`;
  const jobId = `kj_${'3'.repeat(32)}`;
  assert.equal(
    isRuntimeCommand({
      type: 'knowledge.update',
      requestId: 'request-update',
      knowledgeBaseId,
      name: '产品规范',
      description: '说明',
      workspaceIds: [],
      ignoreRules: ['drafts/**'],
      semanticEnabled: true,
    }),
    true,
  );
  assert.equal(
    isRuntimeCommand({
      type: 'knowledge.source.rescan',
      requestId: 'request-rescan',
      sourceId,
      rebuild: true,
    }),
    true,
  );
  assert.equal(
    isRuntimeCommand({
      type: 'knowledge.source.delete',
      requestId: 'request-source-delete',
      sourceId,
    }),
    true,
  );
  assert.equal(
    isRuntimeCommand({
      type: 'knowledge.index.cancel',
      requestId: 'request-index-cancel',
      jobId,
    }),
    true,
  );
  assert.equal(
    isRuntimeCommand({
      type: 'knowledge.update',
      requestId: 'request-invalid-ignore',
      knowledgeBaseId,
      name: '产品规范',
      description: '',
      workspaceIds: [],
      ignoreRules: [''],
    }),
    false,
  );
});

test('private runtime validates bounded editable knowledge text commands and content', () => {
  const knowledgeBaseId = `kb_${'1'.repeat(32)}`;
  const sourceId = `ks_${'2'.repeat(32)}`;
  assert.equal(isRuntimeCommand({
    type: 'knowledge.text.create',
    requestId: 'request-text-create',
    knowledgeBaseId,
    fileName: '公司信息.md',
    content: '# 公司信息\n\n电话：10086',
  }), true);
  assert.equal(isRuntimeCommand({
    type: 'knowledge.text.read',
    requestId: 'request-text-read',
    sourceId,
  }), true);
  assert.equal(isRuntimeCommand({
    type: 'knowledge.text.update',
    requestId: 'request-text-update',
    sourceId,
    expectedSha256: 'a'.repeat(64),
    content: '电话：12345',
  }), true);
  assert.equal(isRuntimeCommand({
    type: 'knowledge.text.create',
    requestId: 'request-text-escape',
    knowledgeBaseId,
    fileName: '../escape.md',
    content: 'unsafe',
  }), false);
  assert.equal(isRuntimeCommand({
    type: 'knowledge.text.create',
    requestId: 'request-text-empty',
    knowledgeBaseId,
    fileName: 'empty.txt',
    content: '   ',
  }), false);
  assert.equal(isRuntimeEvent({
    type: 'knowledge.textDocument',
    requestId: 'request-text-read',
    sequence: 1,
    document: {
      sourceId,
      knowledgeBaseId,
      fileName: '公司信息.md',
      format: 'markdown',
      content: '# 公司信息',
      sha256: 'b'.repeat(64),
      sizeBytes: 14,
    },
  }), true);
});

const SESSION_ID = '33333333-3333-4333-8333-333333333333';

test('private runtime validates lazy task-bound command environments', () => {
  const status = {
    snapshotId: 'environment-7',
    state: 'ready',
    shell: { kind: 'zsh', executable: '/bin/zsh' },
    source: 'shellProfile',
    createdAt: 1_700_000_000_000,
    pathEntries: ['/opt/homebrew/bin', '/usr/bin'],
    variableCount: 24,
    filteredVariableCount: 3,
    profileLoadingEnabled: true,
  } as const;
  assert.equal(isRuntimeCommand({
    type: 'environment.inspect',
    requestId: 'request-environment-inspect',
    workspaceId: 'workspace-fixture',
    threadId: 'thread-fixture',
  }), true);
  assert.equal(isRuntimeCommand({
    type: 'environment.refresh',
    requestId: 'request-environment-refresh',
    workspaceId: 'workspace-fixture',
    threadId: 'thread-fixture',
  }), true);
  assert.equal(isRuntimeCommand({
    type: 'environment.profileLoadingSet',
    requestId: 'request-environment-profile',
    enabled: false,
  }), true);
  assert.equal(isRuntimeEvent({
    type: 'environment.inspection',
    sequence: 1,
    requestId: 'request-environment-inspect',
    status,
  }), true);
  assert.equal(isRuntimeEvent({
    type: 'environment.action',
    sequence: 2,
    requestId: 'request-environment-refresh',
    action: { accepted: true, status },
  }), true);
  assert.equal(isRuntimeEvent({
    type: 'environment.inspection',
    sequence: 3,
    requestId: 'request-environment-invalid',
    status: { ...status, pathEntries: Array(257).fill('/bin') },
  }), false);
});

test('private runtime accepts a local task workspace without a branch', () => {
  const event = {
    type: 'taskWorkspace.inspection',
    sequence: 1,
    requestId: 'request-task-workspace',
    workspace: {
      threadId: 'thread-fixture',
      mode: 'local',
      root: '/fixture/workspace',
    },
  } as const;
  assert.equal(isRuntimeEvent(event), true);
  assert.equal(isRuntimeEvent({
    ...event,
    workspace: { ...event.workspace, branch: null },
  }), false);
});

test('private runtime records an explicit user Stop source', () => {
  const command = {
    type: 'turn.cancel',
    requestId: 'request-cancel',
    workspaceId: 'workspace-fixture',
    threadId: 'thread-fixture',
    turnId: 'turn-fixture',
  };
  assert.equal(isRuntimeCommand({ ...command, source: 'stopButton' }), true);
  assert.equal(isRuntimeCommand(command), false);
});

test('private runtime v6 validates durable queue mutations and steering guards', () => {
  const create = {
    type: 'queue.messageCreate',
    requestId: 'request-queue-create',
    workspaceId: 'workspace-fixture',
    threadId: 'thread-fixture',
    queueItemId: 'queue-fixture',
    modelProfileId: 'profile_1',
    content: [{ type: 'text', text: 'Continue with this detail.' }],
  } as const;
  assert.equal(isRuntimeCommand(create), true);
  assert.equal(
    isRuntimeCommand({
      ...create,
      type: 'queue.messageUpdate',
      expectedRevision: 1,
    }),
    true,
  );
  assert.equal(
    isRuntimeCommand({
      type: 'turn.steerQueued',
      requestId: 'request-queue-steer',
      workspaceId: 'workspace-fixture',
      threadId: 'thread-fixture',
      expectedTurnId: 'turn-fixture',
      queueItemId: 'queue-fixture',
      expectedRevision: 1,
    }),
    true,
  );
  assert.equal(
    isRuntimeCommand({ ...create, type: 'queue.messageUpdate', expectedRevision: 0 }),
    false,
  );
  assert.equal(
    isRuntimeEvent({
      type: 'queue.changed',
      sequence: 7,
      requestId: 'request-queue-create',
      workspaceId: 'workspace-fixture',
      threadId: 'thread-fixture',
      queue: {
        paused: false,
        messages: [{
          id: 'queue-fixture',
          threadId: 'thread-fixture',
          position: 1,
          revision: 1,
          content: create.content,
          modelProfileId: 'profile_1',
          createdAt: 1,
          updatedAt: 1,
        }],
      },
    }),
    true,
  );
});

test('private runtime validates bounded workspace path suggestions', () => {
  assert.equal(
    isRuntimeCommand({
      type: 'workspace.pathSearch',
      requestId: 'request-path-search',
      workspaceId: 'workspace-fixture',
      query: 'composer',
    }),
    true,
  );
  assert.equal(
    isRuntimeEvent({
      type: 'workspace.pathSearchResult',
      sequence: 1,
      requestId: 'request-path-search',
      workspaceId: 'workspace-fixture',
      query: 'composer',
      paths: ['apps/desktop/src/renderer/components/composer/composer-input.tsx'],
      truncated: false,
    }),
    true,
  );
});

test('private runtime validates bounded user-input requests and answers', () => {
  const coordinates = {
    workspaceId: 'workspace-fixture',
    threadId: 'thread-fixture',
    turnId: 'turn-fixture',
    inputRequestId: 'input-fixture',
  };
  const questions = [{
    id: 'delivery_mode',
    header: '实现方式',
    question: '你希望采用哪种实现方式？',
    options: [
      { label: '完整实现（推荐）', description: '一次打通协议、运行时和界面。' },
      { label: '仅做界面', description: '暂时只实现展示。' },
    ],
  }];
  assert.equal(isRuntimeEvent({
    type: 'turn.userInputRequested',
    sequence: 1,
    requestId: 'request-input',
    ...coordinates,
    questions,
  }), true);
  assert.equal(isRuntimeCommand({
    type: 'turn.userInputResponse',
    requestId: 'request-answer',
    ...coordinates,
    submission: {
      kind: 'submitted',
      decisions: [{
        questionId: 'delivery_mode',
        kind: 'answered',
        source: 'option',
        answer: '完整实现（推荐）',
      }],
    },
  }), true);
  assert.equal(isRuntimeCommand({
    type: 'turn.userInputResponse',
    requestId: 'request-cancel',
    ...coordinates,
    submission: {
      kind: 'cancelled',
      decisions: [{ questionId: 'delivery_mode', kind: 'skipped' }],
    },
  }), true);
  assert.equal(isRuntimeCommand({
    type: 'turn.userInputResponse',
    requestId: 'request-invalid-source',
    ...coordinates,
    submission: {
      kind: 'submitted',
      decisions: [{
        questionId: 'delivery_mode',
        kind: 'answered',
        source: 'guessed',
        answer: '完整实现（推荐）',
      }],
    },
  }), false);
  assert.equal(isRuntimeEvent({
    type: 'turn.userInputRequested',
    sequence: 2,
    requestId: 'request-invalid-input',
    ...coordinates,
    questions: [...questions, ...questions, ...questions, ...questions],
  }), false);
});

test('private Thread protocol accepts bounded rename metadata', () => {
  assert.equal(
    isRuntimeCommand({
      type: 'thread.rename',
      requestId: 'request-rename',
      workspaceId: 'workspace-fixture',
      threadId: 'thread-fixture',
      title: '修复会话标题',
    }),
    true,
  );
  assert.equal(
    isRuntimeCommand({
      type: 'thread.rename',
      requestId: 'request-rename-invalid',
      workspaceId: 'workspace-fixture',
      threadId: 'thread-fixture',
      title: '',
    }),
    false,
  );
});

test('private Thread protocol rejects removed fork and archive mutations', () => {
  for (const type of [
    'thread.fork',
    'thread.archive',
    'thread.unarchive',
  ]) {
    assert.equal(
      isRuntimeCommand({
        type,
        requestId: `request-${type}`,
        workspaceId: 'workspace-fixture',
        threadId: 'thread-fixture',
      }),
      false,
    );
  }
  assert.equal(
    isRuntimeEvent({
      type: 'thread.mutated',
      sequence: 1,
      requestId: 'request-archive',
      workspaceId: 'workspace-fixture',
      operation: 'archive',
      threadId: 'thread-fixture',
    }),
    false,
  );
});

test('private runtime v2 validates stable text Item lifecycle events', () => {
  const coordinates = {
    sequence: 1,
    requestId: 'request-turn',
    workspaceId: 'workspace-fixture',
    threadId: 'thread-fixture',
    turnId: 'turn-fixture',
    itemId: 'message-fixture',
  };
  assert.equal(isRuntimeEvent({
    ...coordinates,
    type: 'turn.textStarted',
    phase: 'provisional',
  }), true);
  assert.equal(isRuntimeEvent({
    ...coordinates,
    type: 'turn.textDelta',
    phase: 'provisional',
    delta: 'Working',
  }), true);
  assert.equal(isRuntimeEvent({
    ...coordinates,
    type: 'turn.textCompleted',
    phase: 'final',
    text: 'Done',
  }), true);
  assert.equal(isRuntimeEvent({
    ...coordinates,
    type: 'turn.textCompleted',
    phase: 'provisional',
    text: 'Not authoritative',
  }), false);
});

test('private runtime validates a bounded dedicated plan proposal event', () => {
  const event = {
    type: 'turn.planProposed',
    sequence: 1,
    requestId: 'request-plan',
    workspaceId: 'workspace-plan',
    threadId: 'thread-plan',
    turnId: 'turn-plan',
    planId: 'plan_01',
    content: '# 计划\n\n1. 完成实现。\n2. 运行验证。',
  };
  assert.equal(isRuntimeEvent(event), true);
  assert.equal(isRuntimeEvent({ ...event, content: '' }), false);
  assert.equal(
    isRuntimeEvent({ ...event, content: 'x'.repeat(64 * 1024 + 1) }),
    false,
  );
});

test('private runtime validates complete non-negative usage samples', () => {
  const coordinates = {
    type: 'turn.usage' as const,
    sequence: 1,
    requestId: 'request-usage',
    workspaceId: 'workspace-fixture',
    threadId: 'thread-fixture',
    turnId: 'turn-fixture',
  };
  assert.equal(isRuntimeEvent({
    ...coordinates,
    usage: { inputTokens: 10, outputTokens: 2, totalTokens: 12 },
  }), true);
  assert.equal(isRuntimeEvent({
    ...coordinates,
    usage: {
      inputTokens: 10,
      contextInputTokens: 14,
      outputTokens: 2,
      reasoningTokens: 1,
      cachedInputTokens: 4,
      totalTokens: 12,
    },
  }), true);
  const invalidUsages: unknown[] = [
    { inputTokens: 10, outputTokens: 2 },
    { inputTokens: 10, outputTokens: -1, totalTokens: 12 },
    { inputTokens: 10, outputTokens: 2, totalTokens: Number.NaN },
    {
      inputTokens: 10,
      outputTokens: 2,
      totalTokens: 12,
      reasoningTokens: undefined,
    },
    { inputTokens: 10, outputTokens: 2, totalTokens: 12, provider: 'openai' },
  ];
  for (const usage of invalidUsages) {
    assert.equal(isRuntimeEvent({ ...coordinates, usage }), false);
  }
});

test('private runtime validates context compaction commands and lifecycle', () => {
  const coordinates = {
    requestId: 'request-compact',
    workspaceId: 'workspace-fixture',
    threadId: 'thread-fixture',
    turnId: 'turn-fixture',
  };
  assert.equal(isRuntimeCommand({
    type: 'context.compact',
    ...coordinates,
    modelProfileId: 'model_primary',
    focus: 'Keep migration decisions',
  }), true);
  assert.equal(isRuntimeEvent({
    type: 'turn.contextCompactionStarted',
    sequence: 1,
    ...coordinates,
    compactionId: 'compact-fixture',
    trigger: 'manual',
    strategy: 'applicationSummary',
    beforeContextTokens: 90_000,
  }), true);
  assert.equal(isRuntimeEvent({
    type: 'turn.contextCompactionFinished',
    sequence: 2,
    ...coordinates,
    compactionId: 'compact-fixture',
    trigger: 'manual',
    strategy: 'applicationSummary',
    outcome: 'completed',
    beforeContextTokens: 90_000,
    afterContextTokens: 31_000,
    durationMs: 400,
    readableSummary: 'Continue the migration task.',
  }), true);
});

test('private Workspace protocol stays provider-neutral and bounds browser payloads', () => {
  assert.equal(isRuntimeCommand({
    type: 'workspace.list',
    requestId: 'request-list',
    workspaceId: 'workspace-fixture',
    path: 'src',
  }), true);
  assert.equal(isRuntimeCommand({
    type: 'workspace.list',
    requestId: 'request-root-list',
    workspaceId: 'workspace-fixture',
    path: '',
  }), true);
  assert.equal(isRuntimeCommand({
    type: 'workspace.list',
    requestId: 'request-invalid-root-list',
    workspaceId: 'workspace-fixture',
    path: '.',
  }), false);
  assert.equal(isRuntimeCommand({
    type: 'workspace.inspect',
    requestId: 'request-inspect',
    workspaceId: 'workspace-fixture',
    path: 'x'.repeat(1_025),
  }), false);
  assert.equal(isRuntimeCommand({
    type: 'workspace.resolve',
    requestId: 'request-resolve',
    workspaceId: 'workspace-fixture',
    name: 'extension.tsx',
  }), true);
  assert.equal(isRuntimeCommand({
    type: 'workspace.resolve',
    requestId: 'request-invalid-resolve',
    workspaceId: 'workspace-fixture',
    name: 'src/extension.tsx',
  }), false);
  assert.equal(isRuntimeEvent({
    type: 'workspace.listResult',
    sequence: 1,
    requestId: 'request-list',
    workspaceId: 'workspace-fixture',
    path: '',
    entries: [{ name: 'src', path: 'src', kind: 'directory' }],
  }), true);
  assert.equal(isRuntimeEvent({
    type: 'workspace.inspected',
    sequence: 2,
    requestId: 'request-inspect',
    workspaceId: 'workspace-fixture',
    document: {
      status: 'error',
      path: 'fixture.txt',
      kind: 'providerSpecificFailure',
    },
  }), false);
  assert.equal(isRuntimeEvent({
    type: 'workspace.resolved',
    sequence: 3,
    requestId: 'request-resolve',
    workspaceId: 'workspace-fixture',
    name: 'extension.tsx',
    status: 'resolved',
    path: 'src/components/extension.tsx',
  }), true);
});

test('private terminal protocol requires UUID sessions and UTF-8 byte bounds', () => {
  assert.equal(isRuntimeCommand({
    type: 'terminal.input',
    requestId: 'request-input',
    workspaceId: 'workspace-fixture',
    generation: 1,
    sessionId: SESSION_ID,
    data: '中'.repeat(21_845),
  }), true);
  assert.equal(isRuntimeCommand({
    type: 'terminal.input',
    requestId: 'request-input',
    workspaceId: 'workspace-fixture',
    generation: 1,
    sessionId: SESSION_ID,
    data: '中'.repeat(21_846),
  }), false);
  assert.equal(isRuntimeCommand({
    type: 'terminal.terminate',
    requestId: 'request-terminate',
    workspaceId: 'workspace-fixture',
    generation: 1,
    sessionId: 'not-a-session-id',
  }), false);

  assert.equal(isRuntimeEvent({
    type: 'terminal.output',
    sequence: 1,
    requestId: 'request-terminal',
    workspaceId: 'workspace-fixture',
    generation: 1,
    sessionId: SESSION_ID,
    outputSequence: 1,
    data: '中'.repeat(10_922),
  }), true);
  assert.equal(isRuntimeEvent({
    type: 'terminal.output',
    sequence: 1,
    requestId: 'request-terminal',
    workspaceId: 'workspace-fixture',
    generation: 1,
    sessionId: SESSION_ID,
    outputSequence: 1,
    data: '中'.repeat(10_923),
  }), false);
  assert.equal(isRuntimeEvent({
    type: 'terminal.inputAccepted',
    sequence: 2,
    requestId: 'request-input',
    workspaceId: 'workspace-fixture',
    generation: 1,
    sessionId: SESSION_ID,
    inputBytes: 65_536,
  }), true);
  assert.equal(isRuntimeEvent({
    type: 'operation.output',
    sequence: 3,
    requestId: 'request-turn',
    workspaceId: 'workspace-fixture',
    threadId: 'thread-fixture',
    turnId: 'turn-fixture',
    operationId: 'operation-fixture',
    stream: 'stdout',
    delta: '中'.repeat(10_923),
  }), false);
});

test('private MCP protocol keeps configuration and approval events provider-neutral', () => {
  assert.equal(isRuntimeCommand({
    type: 'mcp.configSave',
    requestId: 'request-config',
    request: {
      expectedRevision: '0'.repeat(64),
      servers: [{
        id: 'fixture',
        transport: 'loopbackStreamableHttp',
        endpoint: 'http://127.0.0.1:8788/mcp',
      }],
    },
  }), true);
  assert.equal(isRuntimeCommand({
    type: 'mcp.sessionSet',
    requestId: 'request-session',
    serverIds: ['fixture', 'fixture'],
  }), false);
  const recoveredApproval = {
    type: 'mcp.approvalRequested',
    sequence: 4,
    requestId: 'request-turn',
    workspaceId: 'workspace-fixture',
    threadId: '019fd4ee-6482-7e10-943a-1ef2ea409dcc',
    turnId: '019fd4ee-6482-7e10-943a-1ef2ea409dce',
    approvalId: 'approval-fixture',
    operationId: 'operation-fixture',
    serverId: 'fixture',
    name: 'mcp__fixture__echo',
    argumentsJson: '{"value":"hello"}',
    argumentsBytes: 17,
    argumentsSha256: 'a'.repeat(64),
    inventorySha256: 'b'.repeat(64),
    recovered: true,
  } as const;
  assert.equal(isRuntimeEvent(recoveredApproval), true);
  assert.equal(isRuntimeEvent({ ...recoveredApproval, recovered: false }), false);
});

test('private Skills protocol bounds native inventory and directory requests', () => {
  const skill = {
    id: `skl_${'a'.repeat(64)}`,
    name: 'code-review',
    description: 'Review a focused change.',
    source: 'project',
    path: '.agents/skills/code-review/SKILL.md',
    sha256: 'b'.repeat(64),
    bytes: 7,
    enabled: true,
  };
  assert.equal(
    isRuntimeCommand({
      type: 'skills.import',
      requestId: 'request-skill-import',
      workspaceId: 'workspace-fixture',
      sourcePath: '/tmp/code-review',
      scope: 'project',
    }),
    true,
  );
  assert.equal(
    isRuntimeCommand({
      type: 'skills.export',
      requestId: 'request-skill-export',
      skillId: skill.id,
      destinationPath: '',
    }),
    false,
  );
  assert.equal(
    isRuntimeEvent({
      type: 'skills.inspection',
      sequence: 1,
      requestId: 'request-skills',
      inspection: { skills: [skill], workspaceAvailable: true },
    }),
    true,
  );
  assert.equal(
    isRuntimeEvent({
      type: 'skills.content',
      sequence: 2,
      requestId: 'request-skill-content',
      content: { skill, content: 'too short' },
    }),
    false,
  );
});

test('private Agent task events carry a complete provider-neutral DAG snapshot', () => {
  const event = {
    type: 'agent.task',
    sequence: 5,
    requestId: 'request-turn',
    workspaceId: 'workspace-fixture',
    threadId: 'thread-fixture',
    turnId: 'turn-fixture',
    task: {
      orchestrationId: 'orch/thread-fixture/turn-fixture',
      taskId: 'task-fixture',
      clientTaskKey: 'implementation',
      childThreadId: SESSION_ID,
      title: 'Implement',
      role: 'worker',
      access: 'workspaceWrite',
      dependsOn: [] as string[],
      taskMarkdown: 'Implement the change.',
      status: 'waitingApproval',
      amendments: [{ id: 'amendment-fixture', markdown: 'Add tests.' }],
      progress: {
        stage: 'runningTool',
        summaryMarkdown: 'Running `workspace_apply_patch`.',
        updatedAt: 123,
      },
    },
  };
  assert.equal(isRuntimeEvent(event), true);
  assert.equal(
    isRuntimeEvent({
      ...event,
      task: { ...event.task, status: 'waiting' },
    }),
    false,
  );
});
