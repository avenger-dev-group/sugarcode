import { describe, expect, it } from 'vitest';

import { DiagnosticTailBuffer } from '../diagnostics';

describe('DiagnosticTailBuffer', () => {
  it('retains only the configured byte tail', () => {
    const diagnostics = new DiagnosticTailBuffer(5);
    diagnostics.append('123');
    diagnostics.append('4567');

    expect(diagnostics.byteLength).toBe(5);
    expect(diagnostics.toString()).toBe('34567');
  });

  it('uses UTF-8 replacement for invalid diagnostic bytes', () => {
    const diagnostics = new DiagnosticTailBuffer(4);
    diagnostics.append(Buffer.from([0xff]));

    expect(diagnostics.toString()).toBe('\uFFFD');
  });
});
