import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, '.', '');
  const apiBaseUrl = env.VITE_API_BASE_URL?.trim() || 'http://154.201.92.160:8000';

  return {
    plugins: [react()],
    define: {
      'import.meta.env.VITE_API_BASE_URL': JSON.stringify(apiBaseUrl)
    },
    server: {
      host: '127.0.0.1',
      port: 5175
    },
    preview: {
      host: '127.0.0.1',
      port: 4175
    }
  };
});
