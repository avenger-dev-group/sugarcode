// @vitest-environment jsdom

import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { DesktopApi } from '@/shared/desktop-api';
import type { ModelConfigInspection } from '@/shared/model-config';

import { SettingsDialog } from '../settings-dialog';

Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', {
  configurable: true,
  value: true,
});

const MODEL_INSPECTION: ModelConfigInspection = {
  contractVersion: 1,
  revision: 'a'.repeat(64),
  config: {
    apiFormat: 'openai-chat-completions',
    endpoint: 'https://api.openai.com/v1/chat/completions',
    model: 'fixture-model',
    credentialReference: null,
  },
  credentialStatus: 'notConfigured',
};

afterEach(() => {
  document.body.replaceChildren();
  vi.clearAllMocks();
});

describe('SettingsDialog', () => {
  it('groups general, model, Skills, and MCP settings behind one trigger', async () => {
    const getModelConfig = vi.fn(async () => MODEL_INSPECTION);
    const toggleTheme = vi.fn();
    Object.defineProperty(window, 'sugarcode', {
      configurable: true,
      value: {
        getConnectionState: vi.fn(async () => ({
          revision: 1,
          status: 'ready',
        })),
        onConnectionStateChanged: vi.fn(
          (): (() => void) => (): void => undefined,
        ),
        getModelConfig,
        saveModelConfig: vi.fn(),
        deleteModelCredential: vi.fn(),
        retryModelConnection: vi.fn(),
      } as unknown as DesktopApi,
    });
    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);

    await act(async () => {
      root.render(
        <SettingsDialog
          isDark={false}
          themeLabel="Use dark theme"
          turnBusy={false}
          toggleTheme={toggleTheme}
        />,
      );
    });
    await act(async () => {
      (
        container.querySelector(
          'button[aria-label="Open settings"]',
        ) as HTMLButtonElement
      ).click();
    });
    await act(async () => Promise.resolve());

    expect(
      document.querySelector('nav[aria-label="Settings sections"]'),
    ).not.toBeNull();
    for (const label of ['General', 'Model', 'Skills', 'MCP']) {
      expect(
        document.querySelector(`button[aria-current="page"]`)?.textContent ===
          label ||
          Array.from(document.querySelectorAll('button')).some(
            (button) => button.textContent === label,
          ),
      ).toBe(true);
    }

    const darkButton = Array.from(document.querySelectorAll('button')).find(
      (button) => button.textContent === 'Dark',
    ) as HTMLButtonElement;
    await act(async () => darkButton.click());
    expect(toggleTheme).toHaveBeenCalledTimes(1);

    const modelButton = Array.from(document.querySelectorAll('button')).find(
      (button) => button.textContent === 'Model',
    ) as HTMLButtonElement;
    await act(async () => modelButton.click());
    await act(async () => Promise.resolve());
    expect(getModelConfig).toHaveBeenCalledTimes(1);
    expect(document.querySelector('#model-endpoint')).not.toBeNull();

    const skillsButton = Array.from(document.querySelectorAll('button')).find(
      (button) => button.textContent === 'Skills',
    ) as HTMLButtonElement;
    await act(async () => skillsButton.click());
    expect(document.body.textContent).toContain(
      '.agents/skills/<name>/SKILL.md',
    );

    await act(async () => root.unmount());
  });
});
