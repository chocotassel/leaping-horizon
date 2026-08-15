import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  build: {
    target: 'es2017',
    cssCodeSplit: true,
    rollupOptions: {
      input: ['index.html', 'beat-marker.html', 'rhythm-lab.html'],
      output: {
        manualChunks(id) {
          return id.includes('node_modules/three') ? 'three' : undefined;
        },
      },
    },
  },
});
