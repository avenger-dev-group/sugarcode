import assert from 'node:assert/strict';
import test from 'node:test';

import { isKnowledgeInspection } from '../../src/shared/knowledge.ts';

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
