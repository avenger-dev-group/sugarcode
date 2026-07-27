import path from 'node:path';

import { defineConfig } from 'vite';

export default defineConfig({
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
  build: {
    emptyOutDir: true,
    outDir: '.electron-test',
    ssr: 'electron-tests/command-approval-main.ts',
    rollupOptions: {
      external: ['electron', /^node:/],
      output: {
        entryFileNames: 'main.cjs',
        format: 'cjs',
      },
    },
  },
});
