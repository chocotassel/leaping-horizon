import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  build: {
    target: 'es2017',
    cssCodeSplit: true,
    rollupOptions: {
      output: {
        manualChunks(id) {
          return id.includes('node_modules/three') ? 'three' : undefined;
        },
      },
    },
  },
});
