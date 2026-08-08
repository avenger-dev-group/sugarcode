import assert from 'node:assert/strict';
import test from 'node:test';

import { codeLanguageForPath } from '../../../src/renderer/utils/code-language.ts';

test('workspace code language follows the file extension across path styles', () => {
  assert.deepEqual(codeLanguageForPath('src/components/extension.tsx'), {
    highlight: 'typescript',
    label: 'TypeScript React',
  });
  assert.deepEqual(codeLanguageForPath('src\\pages\\index.html'), {
    highlight: 'html',
    label: 'HTML',
  });
});

test('workspace code language safely falls back for extensionless files', () => {
  assert.deepEqual(codeLanguageForPath('Dockerfile'), {
    highlight: undefined,
    label: 'Plain text',
  });
});
