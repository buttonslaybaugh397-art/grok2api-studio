import { defineConfig, loadEnv, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';

function mediaProxyPlugin(): Plugin {
  const handler = async (req: any, res: any, next: any) => {
    try {
      const url = String(req.url || '');
      if (!url.startsWith('/__proxy/media')) {
        next();
        return;
      }

      if (req.method === 'OPTIONS') {
        res.statusCode = 204;
        res.setHeader('Access-Control-Allow-Origin', '*');
        res.setHeader('Access-Control-Allow-Methods', 'GET,OPTIONS');
        res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Range');
        res.end();
        return;
      }

      if (req.method !== 'GET' && req.method !== 'HEAD') {
        res.statusCode = 405;
        res.end('method not allowed');
        return;
      }

      const incoming = new URL(url, 'http://127.0.0.1');
      const remote = (incoming.searchParams.get('url') || '').trim();
      if (!remote) {
        res.statusCode = 400;
        res.end('url query is required');
        return;
      }

      let target: URL;
      try {
        target = new URL(remote);
      } catch {
        res.statusCode = 400;
        res.end('invalid media url');
        return;
      }

      if (!/^https?:$/i.test(target.protocol)) {
        res.statusCode = 400;
        res.end('only http/https media is allowed');
        return;
      }

      const headers: Record<string, string> = {
        'User-Agent': String(req.headers['user-agent'] || 'GrokStudioMediaProxy/1.0'),
        Accept: String(req.headers.accept || '*/*')
      };
      if (req.headers.range) headers.Range = String(req.headers.range);

      const upstream = await fetch(target.toString(), { headers });
      res.statusCode = upstream.status;
      res.setHeader('Access-Control-Allow-Origin', '*');
      res.setHeader('Cache-Control', 'private, max-age=300');

      for (const key of [
        'content-type',
        'content-length',
        'content-range',
        'accept-ranges',
        'content-disposition',
        'etag',
        'last-modified'
      ]) {
        const value = upstream.headers.get(key);
        if (value) res.setHeader(key, value);
      }

      if (req.method === 'HEAD') {
        res.end();
        return;
      }

      const bytes = new Uint8Array(await upstream.arrayBuffer());
      res.end(bytes);
    } catch (error: any) {
      if (!res.headersSent) {
        res.statusCode = 502;
        res.end(error?.message || 'media proxy failed');
      } else {
        res.end();
      }
    }
  };

  return {
    name: 'studio-media-proxy',
    configureServer(server) {
      server.middlewares.use(handler);
    },
    configurePreviewServer(server) {
      server.middlewares.use(handler);
    }
  };
}

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, '.', '');
  const proxyTarget = env.VITE_DEV_PROXY_TARGET?.trim() || 'http://154.201.92.160:8000';
  // Empty by default: browser stays same-origin and uses local proxy (dev/preview/server.mjs).
  const apiBaseUrl = env.VITE_API_BASE_URL?.trim() ?? '';

  const proxy = {
    '/v1': {
      target: proxyTarget,
      changeOrigin: true,
      secure: false
    }
  };

  return {
    plugins: [react(), mediaProxyPlugin()],
    define: {
      'import.meta.env.VITE_API_BASE_URL': JSON.stringify(apiBaseUrl),
      'import.meta.env.VITE_DEV_PROXY_TARGET': JSON.stringify(proxyTarget)
    },
    server: {
      host: '127.0.0.1',
      port: 5175,
      proxy
    },
    preview: {
      host: '127.0.0.1',
      port: 4175,
      proxy
    }
  };
});
