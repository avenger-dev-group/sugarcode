import type { DesktopApi } from '@/shared/connection';

declare global {
  interface Window {
    sugarcode: DesktopApi;
  }
}

export {};
