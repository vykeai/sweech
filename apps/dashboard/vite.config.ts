import path from 'node:path';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      '@vykeai/vysual-react': path.resolve(__dirname, '../../packages/vysual-react/src/index.tsx'),
    },
  },
  build: {
    outDir: '../../dist/dashboard',
    emptyOutDir: true,
  },
});
