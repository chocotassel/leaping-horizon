import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { base64AssetPlugin, levelEditorPlugin, runtimeLevelPlugin } from './vite.base64-plugin.ts';

export default defineConfig({
  plugins: [base64AssetPlugin(), runtimeLevelPlugin(), levelEditorPlugin(), react()],
  build: {
    target: 'es2017',
    cssCodeSplit: true,
    rollupOptions: {
      input: ['index.html'],
      output: {
        manualChunks(id) {
          return id.includes('node_modules/three') ? 'three' : undefined;
        },
      },
    },
  },
});
