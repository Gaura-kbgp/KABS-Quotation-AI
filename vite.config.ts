import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';

// https://vitejs.dev/config/
export default defineConfig(({ mode }) => {
  // Cast process to any to avoid conflict with client-side 'process' declaration in vite-env.d.ts
  // This is safe because this file runs in Node.js, not the browser.
  const cwd = (process as any).cwd();
  const env = loadEnv(mode, cwd, '');
  
  return {
    plugins: [react()],
    define: {
      // Replaces process.env in client code with the stringified object of environment variables
      'process.env': JSON.stringify(env)
    },
    build: {
      outDir: 'dist',
      sourcemap: false,
      rollupOptions: {
        output: {
          manualChunks: {
            'vendor-react': ['react', 'react-dom', 'react-router-dom'],
            'vendor-pdf': ['pdfjs-dist', 'jspdf', 'jspdf-autotable'],
            'vendor-excel': ['xlsx', 'jszip'],
            'vendor-ui': ['lucide-react']
          }
        }
      }
    }
  };
});