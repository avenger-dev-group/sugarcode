import assert from 'node:assert/strict';
import { mkdtemp, mkdir, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { RuntimeKnowledgeController } from '../../../src/main/runtime/knowledge-controller.ts';
import type { KnowledgeBaseDetail } from '../../../src/shared/knowledge.ts';

const knowledgeBaseId = `kb_${'1'.repeat(32)}`;
const sourceId = `ks_${'2'.repeat(32)}`;
const documentId = `kd_${'3'.repeat(32)}`;

const controllerFixture = (
  detail: KnowledgeBaseDetail,
  opened: string[],
  revealed: string[],
): RuntimeKnowledgeController =>
  new RuntimeKnowledgeController({
    runtime: {
      request: async () => ({ type: 'knowledge.detail', detail }),
    } as never,
    dialog: { showOpenDialog: async () => ({ canceled: true, filePaths: [] }) },
    getMainWindow: () => null,
    getWorkspace: () => ({ workspaceId: 'workspace-fixture' }),
    shell: {
      openPath: async (target) => {
        opened.push(target);
        return '';
      },
      showItemInFolder: (target) => {
        revealed.push(target);
      },
    },
  });

const detailFixture = (
  root: string,
  relativePath: string,
): KnowledgeBaseDetail => ({
  sources: [{
    id: sourceId,
    knowledgeBaseId,
    kind: 'linkedFolder',
    path: root,
    displayName: '产品规范',
    documentCount: 1,
    errorCount: 0,
    updatedAt: 1,
  }],
  documents: [{
    id: documentId,
    knowledgeBaseId,
    sourceId,
    relativePath,
    fileName: path.basename(relativePath),
    mediaType: 'text/markdown',
    sizeBytes: 1,
    modifiedAt: 1,
    sha256: 'a'.repeat(64),
    parseStatus: 'ready',
    chunkCount: 1,
    updatedAt: 1,
  }],
});

test('knowledge document actions reopen only the canonical indexed source path', async () => {
  const fixtureRoot = await mkdtemp(path.join(tmpdir(), 'sugarcode-knowledge-open-'));
  const linkedRoot = path.join(fixtureRoot, 'linked');
  const target = path.join(linkedRoot, 'spec', 'retrieval.md');
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(target, 'atomic switch');
  const opened: string[] = [];
  const revealed: string[] = [];
  const controller = controllerFixture(
    detailFixture(linkedRoot, 'spec/retrieval.md'),
    opened,
    revealed,
  );

  try {
    assert.deepEqual(await controller.openDocument(knowledgeBaseId, documentId), {
      accepted: true,
    });
    assert.deepEqual(await controller.revealDocument(knowledgeBaseId, documentId), {
      accepted: true,
    });
    const canonicalTarget = await realpath(target);
    assert.deepEqual(opened, [canonicalTarget]);
    assert.deepEqual(revealed, [canonicalTarget]);
  } finally {
    await rm(fixtureRoot, { recursive: true, force: true });
  }
});

test('knowledge document actions reject a linked-source symlink escape', async () => {
  const fixtureRoot = await mkdtemp(path.join(tmpdir(), 'sugarcode-knowledge-escape-'));
  const linkedRoot = path.join(fixtureRoot, 'linked');
  const outside = path.join(fixtureRoot, 'outside.md');
  await mkdir(linkedRoot, { recursive: true });
  await writeFile(outside, 'outside');
  await symlink(outside, path.join(linkedRoot, 'escape.md'));
  const opened: string[] = [];
  const controller = controllerFixture(
    detailFixture(linkedRoot, 'escape.md'),
    opened,
    [],
  );

  try {
    const result = await controller.openDocument(knowledgeBaseId, documentId);
    assert.equal(result.accepted, false);
    assert.equal('message' in result ? result.message : '', '知识来源路径越界。');
    assert.deepEqual(opened, []);
  } finally {
    await rm(fixtureRoot, { recursive: true, force: true });
  }
});

test('knowledge document actions bind the document to its requested knowledge base', async () => {
  const controller = controllerFixture({ sources: [], documents: [] }, [], []);
  const result = await controller.openDocument(
    `kb_${'f'.repeat(32)}`,
    documentId,
  );
  assert.equal(result.accepted, false);
  assert.match('message' in result ? result.message ?? '' : '', /不存在|当前知识库/u);
});

test('knowledge text editing validates file names and preserves optimistic revisions', async () => {
  const requests: unknown[] = [];
  const controller = new RuntimeKnowledgeController({
    runtime: {
      request: async (command: unknown) => {
        requests.push(command);
        return { type: 'knowledge.action', action: { accepted: true } };
      },
    } as never,
    dialog: { showOpenDialog: async () => ({ canceled: true, filePaths: [] }) },
    getMainWindow: () => null,
    getWorkspace: () => ({ workspaceId: 'workspace-fixture' }),
    shell: { openPath: async () => '', showItemInFolder: () => undefined },
  });

  assert.deepEqual(
    await controller.createTextDocument(knowledgeBaseId, {
      fileName: '../escape.md',
      content: 'unsafe',
    }),
    { accepted: false, reason: 'invalid' },
  );
  assert.deepEqual(
    await controller.createTextDocument(knowledgeBaseId, {
      fileName: '公司信息.md',
      content: '# 公司信息',
    }),
    { accepted: true },
  );
  assert.deepEqual(
    await controller.updateTextDocument(sourceId, {
      expectedSha256: 'a'.repeat(64),
      content: '电话：12345',
    }),
    { accepted: true },
  );
  assert.equal(requests.length, 2);
  assert.equal((requests[1] as { expectedSha256?: string }).expectedSha256, 'a'.repeat(64));
});
