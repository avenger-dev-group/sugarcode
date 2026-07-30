// @vitest-environment jsdom

import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { DesktopApi } from '@/shared/desktop-api';
import type { PreviewStateSnapshot } from '@/shared/preview';

import { PreviewWorkbench } from '../preview-workbench';

const sessionId = '12345678-1234-4123-8123-123456789abc';

describe('PreviewWorkbench', () => {
  it('opens only through the fixed workspace-generation request and renders active controls', async () => {
    let previewListener:
      | ((snapshot: PreviewStateSnapshot) => void)
      | undefined;
    const openPreview = vi.fn(async () => {
      previewListener?.({
        revision: 1,
        status: 'ready',
        generation: 6,
        sessionId,
        url: 'http://127.0.0.1:4173/app',
        origin: 'http://127.0.0.1:4173',
        visible: true,
        canGoBack: false,
        canGoForward: true,
      });
      return { accepted: true as const, reason: 'accepted' as const };
    });
    const closePreview = vi.fn(async () => ({
      accepted: true as const,
      reason: 'accepted' as const,
    }));
    Object.defineProperty(window, 'sugarcode', {
      configurable: true,
      value: {
        getPreviewState: vi.fn(async () => ({
          revision: 0,
          status: 'closed' as const,
        })),
        onPreviewStateChanged: vi.fn((listener) => {
          previewListener = listener;
          return () => {
            previewListener = undefined;
          };
        }),
        getWorkspaceState: vi.fn(async () => ({
          revision: 2,
          generation: 6,
          status: 'ready' as const,
          name: 'preview-project',
        })),
        onWorkspaceStateChanged: vi.fn(
          (): (() => void) => () => undefined,
        ),
        openPreview,
        showPreview: vi.fn(),
        reloadPreview: vi.fn(async () => ({
          accepted: true as const,
          reason: 'accepted' as const,
        })),
        goBackPreview: vi.fn(),
        goForwardPreview: vi.fn(),
        closePreview,
      } as unknown as DesktopApi,
    });

    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);
    await act(async () => root.render(<PreviewWorkbench />));
    await act(async () => Promise.resolve());

    await act(async () => {
      (
        container.querySelector(
          'button[title="Static preview"]',
        ) as HTMLButtonElement
      ).click();
    });
    const input = container.querySelector(
      '#local-preview-url',
    ) as HTMLInputElement;
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(
        HTMLInputElement.prototype,
        'value',
      )?.set;
      setter?.call(input, 'http://127.0.0.1:4173/app');
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await act(async () => {
      (
        [...container.querySelectorAll('button')].find(
          (button) => button.textContent?.trim() === 'Open local preview',
        ) as HTMLButtonElement
      ).click();
    });
    await act(async () => Promise.resolve());

    expect(openPreview).toHaveBeenCalledWith({
      generation: 6,
      url: 'http://127.0.0.1:4173/app',
    });
    expect(container.textContent).toContain(
      'http://127.0.0.1:4173',
    );
    expect(container.textContent).toContain('Visible');
    expect(container.textContent).toContain('Forward');

    await act(async () => {
      (
        [...container.querySelectorAll('button')].find(
          (button) => button.textContent?.trim() === 'Stop preview',
        ) as HTMLButtonElement
      ).click();
    });
    expect(closePreview).toHaveBeenCalledWith({
      generation: 6,
      sessionId,
    });
    await act(async () => root.unmount());
  });
});

Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', {
  configurable: true,
  value: true,
});

afterEach(() => document.body.replaceChildren());
