import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: { '/api': 'http://127.0.0.1:3000' },
  },
  // exceljs (users template only, loaded on demand) is a ~930 kB chunk of its own
  build: { outDir: 'dist', sourcemap: false, chunkSizeWarningLimit: 1000 },
});
