import path from 'node:path';

import { defineConfig } from 'vite';

export default defineConfig({
  build: {
    lib: {
      entry: path.resolve(__dirname, 'src/runtime/entry.ts'),
      fileName: () => 'runtime.mjs',
      formats: ['es'],
    },
    rollupOptions: {
      output: {
        banner:
          "import { createRequire as __sugarcodeCreateRequire } from 'node:module'; const require = __sugarcodeCreateRequire(import.meta.url);",
      },
    },
  },
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
});
