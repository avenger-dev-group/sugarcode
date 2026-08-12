import path from 'node:path';

import { defineConfig } from 'vite';

const updatePublicKey = process.env.SUGARCODE_UPDATE_PUBLIC_KEY_B64
  ? Buffer.from(process.env.SUGARCODE_UPDATE_PUBLIC_KEY_B64, 'base64').toString(
      'utf8',
    )
  : '';

// https://vitejs.dev/config
export default defineConfig({
  define: {
    SUGARCODE_UPDATE_PUBLIC_KEY: JSON.stringify(updatePublicKey),
  },
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
});
