// @vitest-environment jsdom

import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it } from 'vitest';

import { FileInspector } from '../file-inspector';

afterEach(() => {
  document.body.replaceChildren();
});

describe('FileInspector', () => {
  it('renders selectable full text with language, bounds, and line numbers', async () => {
    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);
    await act(async () =>
      root.render(
        <FileInspector
          document={{
            status: 'complete',
            path: 'src/main.rs',
            content: 'fn main() {\n  println!("hi");\n}\n',
            bytes: 34,
            lines: 3,
            hasUtf8Bom: false,
          }}
        />,
      ),
    );

    expect(container.textContent).toContain('Rust · 34 bytes · 3 lines');
    expect(container.querySelector('code')?.textContent).toContain(
      'println!("hi")',
    );
    expect(
      container.querySelector('[aria-label="Read-only file content"]'),
    ).not.toBeNull();
    expect(container.querySelector('pre')?.textContent).toBe('1\n2\n3');
    await act(async () => root.unmount());
  });

  it('labels a bounded preview without pretending it is complete', async () => {
    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);
    await act(async () =>
      root.render(
        <FileInspector
          document={{
            status: 'truncated',
            path: 'large.txt',
            content: 'prefix',
            bytes: 2_000_000,
            returnedBytes: 6,
            lines: 100_000,
            hasUtf8Bom: false,
          }}
        />,
      ),
    );
    expect(container.textContent).toContain('Bounded preview');
    expect(container.textContent).toContain('6 bytes shown');
    await act(async () => root.unmount());
  });
});
