import assert from 'node:assert/strict';
import test from 'node:test';

import {
  isKnowledgeActionResult,
  isKnowledgeBaseDetail,
  isKnowledgeEditableDocument,
  isKnowledgeInspection,
} from '../../src/shared/knowledge.ts';

test('editable knowledge documents are bounded UTF-8 text metadata', () => {
  const value = {
    sourceId: `ks_${'1'.repeat(32)}`,
    knowledgeBaseId: `kb_${'2'.repeat(32)}`,
    fileName: '公司信息.md',
    format: 'markdown',
    content: '# 公司信息',
    sha256: 'a'.repeat(64),
    sizeBytes: 14,
  };
  assert.equal(isKnowledgeEditableDocument(value), true);
  assert.equal(isKnowledgeEditableDocument({ ...value, format: 'html' }), false);
  assert.equal(isKnowledgeEditableDocument({ ...value, sha256: 'stale' }), false);
});

const inspection = {
  knowledgeBases: [],
  semanticModel: {
    state: 'notInstalled',
    enabled: false,
    modelId: 'intfloat/multilingual-e5-small',
    version: '2026-04-02',
    revision: '614241f622f53c4eeff9890bdc4f31cfecc418b3',
    dimensions: 384,
    runtime: 'ONNX Runtime CPU',
    variant: 'INT8 优化',
    downloadedBytes: 0,
    totalBytes: 135_392_178,
    installedBytes: 0,
    semanticIndex: {
      state: 'notIndexed',
      indexedChunks: 0,
      totalChunks: 0,
      errorCount: 0,
    },
    device: {
      architecture: 'aarch64',
      logicalCores: 10,
      totalMemoryBytes: 16 * 1024 ** 3,
      availableMemoryBytes: 8 * 1024 ** 3,
      availableDiskBytes: 100 * 1024 ** 3,
      requiredDiskBytes: 2 * 1024 ** 3,
      supported: true,
      recommended: true,
      warnings: [],
    },
  },
} as const;

test('knowledge inspection accepts bounded semantic model device state', () => {
  assert.equal(isKnowledgeInspection(inspection), true);
  assert.equal(
    isKnowledgeInspection({
      ...inspection,
      semanticModel: { ...inspection.semanticModel, downloadedBytes: -1 },
    }),
    false,
  );
  assert.equal(
    isKnowledgeInspection({
      ...inspection,
      semanticModel: { ...inspection.semanticModel, revision: 'main' },
    }),
    false,
  );
});

test('knowledge inspection accepts the real four-plan catalog and pending atomic switch', () => {
  const semanticPlan = (id: string, dimensions: number) => ({
    id,
    name: id,
    description: 'fixture',
    language: 'fixture',
    downloadBytes: 10,
    model: {
      id,
      name: id,
      description: 'fixture',
      language: 'fixture',
      version: 'fixture-v1',
      revision: '1'.repeat(40),
      dimensions,
      minimumAppVersion: '3.3.2',
    },
  });
  const value = {
    ...inspection,
    retrievalPlans: [
      {
        id: 'fullText',
        name: '全文检索',
        description: 'fixture',
        language: 'all',
        downloadBytes: 0,
      },
      semanticPlan('BAAI/bge-small-zh-v1.5', 512),
      semanticPlan('intfloat/multilingual-e5-small', 384),
      semanticPlan('Snowflake/snowflake-arctic-embed-xs', 384),
    ],
    retrievalSettings: {
      strategy: 'semantic',
      selectedPlanId: 'BAAI/bge-small-zh-v1.5',
      activeModelId: 'intfloat/multilingual-e5-small',
      activeModelVersion: '2026-04-02',
      pendingModelId: 'BAAI/bge-small-zh-v1.5',
      pendingModelVersion: 'fixture-v1',
      indexPaused: false,
    },
  } as const;
  assert.equal(isKnowledgeInspection(value), true);
  assert.equal(
    isKnowledgeInspection({
      ...value,
      retrievalPlans: value.retrievalPlans.slice(0, 3),
    }),
    false,
  );
});

test('knowledge detail accepts optional source health and durable index jobs', () => {
  const detail = {
    sources: [
      {
        id: `ks_${'1'.repeat(32)}`,
        knowledgeBaseId: `kb_${'2'.repeat(32)}`,
        kind: 'linkedFolder',
        path: '/fixtures/knowledge',
        displayName: 'knowledge',
        documentCount: 2,
        errorCount: 0,
        status: 'scanning',
        lastScannedAt: 1_700_000_000,
        updatedAt: 1_700_000_000,
      },
    ],
    documents: [],
    ignoreRules: ['drafts/**'],
    indexJobs: [
      {
        id: `kj_${'3'.repeat(32)}`,
        knowledgeBaseId: `kb_${'2'.repeat(32)}`,
        sourceId: `ks_${'1'.repeat(32)}`,
        kind: 'incremental',
        status: 'running',
        discoveredFiles: 2,
        processedFiles: 1,
        indexedFiles: 1,
        skippedFiles: 0,
        deletedFiles: 0,
        errorCount: 0,
        attemptCount: 1,
        cancelRequested: false,
        createdAt: 1_700_000_000,
        updatedAt: 1_700_000_001,
      },
    ],
  } as const;
  assert.equal(isKnowledgeBaseDetail(detail), true);
  assert.equal(
    isKnowledgeBaseDetail({
      ...detail,
      indexJobs: [{ ...detail.indexJobs[0], processedFiles: -1 }],
    }),
    false,
  );
  assert.equal(
    isKnowledgeActionResult({
      accepted: true,
      jobId: `kj_${'3'.repeat(32)}`,
      indexed: 1,
      deleted: 1,
    }),
    true,
  );
});
