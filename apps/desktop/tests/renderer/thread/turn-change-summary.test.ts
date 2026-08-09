import assert from 'node:assert/strict';
import test from 'node:test';

import { collectTurnChangeSummaryFiles } from '../../../src/renderer/components/thread/turn-change-summary-data.ts';
import type { TurnActivityViewModel } from '../../../src/renderer/components/thread/types.ts';

const patchActivity = (
  id: string,
  path: string,
  before: string,
  after: string,
): TurnActivityViewModel => ({
  type: 'commandApproval',
  activity: {
    id,
    operationKind: 'workspacePatch',
    command: 'Update src/file.ts',
    argumentCount: 0,
    state: 'approved',
    executionResult: {
      id: `${id}:result`,
      state: 'recorded',
      outcome: {
        type: 'workspacePatch',
        filesChanged: 1,
        files: [{
          path,
          kind: 'update',
          beforeSha256: 'a'.repeat(64),
          afterSha256: 'b'.repeat(64),
          beforeBytes: before.length,
          afterBytes: after.length,
          diff: `--- a/${path}\n+++ b/${path}\n@@ -1,1 +1,1 @@\n-${before}\n+${after}\n`,
          newlineStyle: 'lf',
          finalNewline: true,
        }],
      },
    },
  },
});

test('Turn change summary keeps one latest review row per modified path', () => {
  const files = collectTurnChangeSummaryFiles([
    patchActivity('first', 'src/example.ts', 'one', 'two'),
    patchActivity('second', 'src/example.ts', 'two', 'three'),
    patchActivity('third', 'src/other.ts', 'old', 'new'),
  ]);

  assert.deepEqual(files.map((entry) => entry.file.path), [
    'src/example.ts',
    'src/other.ts',
  ]);
  assert.equal(files[0]?.reviews.length, 2);
  assert.equal(files[0]?.reviews[0]?.additions, 1);
  assert.equal(files[0]?.reviews[0]?.deletions, 1);
  assert.equal(files[0]?.reviews[1]?.hunks[0]?.lines[1]?.text, 'three');
});
