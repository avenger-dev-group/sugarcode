export const DEFAULT_DIAGNOSTIC_LIMIT_BYTES = 64 * 1024;

export class DiagnosticTailBuffer {
  private readonly limitBytes: number;
  private tail: Buffer = Buffer.alloc(0);

  constructor(limitBytes = DEFAULT_DIAGNOSTIC_LIMIT_BYTES) {
    if (!Number.isSafeInteger(limitBytes) || limitBytes < 1) {
      throw new Error('Diagnostic byte limit must be a positive integer.');
    }
    this.limitBytes = limitBytes;
  }

  append = (chunk: Buffer | string): void => {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    if (bytes.length >= this.limitBytes) {
      this.tail = bytes.subarray(bytes.length - this.limitBytes);
      return;
    }
    const combined = Buffer.concat([this.tail, bytes]);
    this.tail =
      combined.length > this.limitBytes
        ? combined.subarray(combined.length - this.limitBytes)
        : combined;
  };

  toString = (): string => this.tail.toString('utf8');

  get byteLength(): number {
    return this.tail.length;
  }
}
