import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: { '/api': 'http://127.0.0.1:3000' },
  },
  // exceljs / write-excel-file / read-excel-file (users-import only, dynamically imported) stay out of
  // the initial bundle as their own async chunks. manualChunks splits the React/router runtime into a
  // long-lived `vendor` chunk so it caches across app-code deploys and the entry chunk shrinks.
  build: {
    outDir: 'dist',
    sourcemap: false,
    chunkSizeWarningLimit: 1000,
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (/[\\/]node_modules[\\/](react|react-dom|react-router|react-router-dom|scheduler)[\\/]/.test(id)) return 'vendor';
        },
      },
    },
  },
});
