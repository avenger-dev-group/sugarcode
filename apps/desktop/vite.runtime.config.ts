import path from 'node:path';

import { defineConfig } from 'vite';

export default defineConfig({
  build: {
    lib: {
      entry: path.resolve(__dirname, 'src/runtime/entry.ts'),
      fileName: () => 'runtime.js',
      formats: ['cjs'],
    },
    rollupOptions: {
      external: [
        '@anthropic-ai/sdk',
        '@google/adk',
        '@google/genai',
        'openai',
      ],
    },
  },
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
});
