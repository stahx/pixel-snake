import { defineConfig } from 'vite';
import vue from '@vitejs/plugin-vue';
import { fileURLToPath } from 'node:url';

export default defineConfig({
  root: fileURLToPath(new URL('./src/lab', import.meta.url)),
  base: '/lab/',
  plugins: [vue()],
  build: {
    outDir: fileURLToPath(new URL('./dist/lab', import.meta.url)),
    emptyOutDir: true,
    rolldownOptions: { output: { manualChunks: (id) => /node_modules\/.*(?:echarts|zrender)/.test(id) ? 'charts' : undefined } },
  },
});
