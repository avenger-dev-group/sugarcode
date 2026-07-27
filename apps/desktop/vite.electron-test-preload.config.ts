import path from 'node:path';

import { defineConfig } from 'vite';

export default defineConfig({
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
  build: {
    emptyOutDir: false,
    outDir: '.electron-test',
    ssr: 'src/preload.ts',
    rollupOptions: {
      external: ['electron'],
      output: {
        entryFileNames: 'preload.cjs',
        format: 'cjs',
      },
    },
  },
});
