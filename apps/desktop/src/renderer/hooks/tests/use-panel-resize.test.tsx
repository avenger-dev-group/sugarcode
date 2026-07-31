// @vitest-environment jsdom

import { act, useState } from 'react';
import { createRoot } from 'react-dom/client';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { usePanelResize } from '../use-panel-resize';

Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', {
  configurable: true,
  value: true,
});

HTMLElement.prototype.setPointerCapture = vi.fn();

const ResizeFixture = () => {
  const [width, setWidth] = useState<number>(286);
  const resize = usePanelResize({
    width,
    minWidth: 240,
    maxWidth: 380,
    onResize: setWidth,
  });

  return (
    <div
      role="separator"
      aria-valuenow={resize.width}
      onKeyDown={resize.onKeyDown}
      onPointerDown={resize.onPointerDown}
    />
  );
};

afterEach(() => {
  document.body.replaceChildren();
  document.body.classList.remove('is-resizing-panel');
  vi.clearAllMocks();
});

describe('usePanelResize', () => {
  it('supports bounded keyboard resizing and pointer drag state', async () => {
    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);
    await act(async () => root.render(<ResizeFixture />));
    const separator = document.querySelector(
      '[role="separator"]',
    ) as HTMLDivElement;

    await act(async () => {
      separator.dispatchEvent(
        new KeyboardEvent('keydown', {
          key: 'ArrowRight',
          bubbles: true,
        }),
      );
    });
    expect(separator.getAttribute('aria-valuenow')).toBe('294');

    await act(async () => {
      separator.dispatchEvent(
        new KeyboardEvent('keydown', {
          key: 'ArrowLeft',
          shiftKey: true,
          bubbles: true,
        }),
      );
    });
    expect(separator.getAttribute('aria-valuenow')).toBe('262');

    const pointerDown = new MouseEvent('pointerdown', {
      bubbles: true,
      clientX: 100,
    });
    Object.defineProperty(pointerDown, 'pointerId', { value: 1 });
    await act(async () => separator.dispatchEvent(pointerDown));
    expect(document.body.classList.contains('is-resizing-panel')).toBe(true);

    await act(async () => {
      document.dispatchEvent(
        new MouseEvent('pointermove', { clientX: 500 }),
      );
    });
    expect(separator.getAttribute('aria-valuenow')).toBe('380');

    await act(async () => {
      document.dispatchEvent(new MouseEvent('pointerup'));
    });
    expect(document.body.classList.contains('is-resizing-panel')).toBe(false);
    await act(async () => root.unmount());
  });
});
