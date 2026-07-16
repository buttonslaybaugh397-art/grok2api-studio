/**
 * Standalone reverse-proxy server for Grok Studio.
 * Serves the built SPA and proxies /v1/* to an upstream API to avoid browser CORS.
 *
 * Usage:
 *   node server.mjs
 *   set STUDIO_PROXY_TARGET=http://154.201.92.160:8000 && node server.mjs
 *   set PORT=4175 && node server.mjs
 */
import http from 'node:http';
import https from 'node:https';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { URL } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PORT = Number(process.env.PORT || process.env.STUDIO_PORT || 4175);
const HOST = process.env.HOST || '127.0.0.1';
const DIST_DIR = path.resolve(__dirname, 'dist');
const DEFAULT_TARGET = process.env.STUDIO_PROXY_TARGET || process.env.VITE_DEV_PROXY_TARGET || 'http://154.201.92.160:8000';

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.map': 'application/json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8'
};

function send(res, status, body, headers = {}) {
  const payload = typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    ...headers
  });
  res.end(payload);
}

function safeJoin(root, requestPath) {
  const decoded = decodeURIComponent(requestPath.split('?')[0]);
  const cleaned = path.normalize(decoded).replace(/^([/\\])+/, '');
  const full = path.join(root, cleaned);
  if (!full.startsWith(root)) return null;
  return full;
}

function serveStatic(req, res) {
  if (!fs.existsSync(DIST_DIR)) {
    return send(res, 500, {
      error: {
        message: 'dist/ not found. Run npm run build first.',
        type: 'studio_static_missing'
      }
    });
  }

  const urlPath = req.url || '/';
  let filePath = safeJoin(DIST_DIR, urlPath === '/' ? '/index.html' : urlPath);
  if (!filePath) {
    return send(res, 400, { error: { message: 'invalid path' } });
  }

  if (!fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) {
    // SPA fallback
    filePath = path.join(DIST_DIR, 'index.html');
  }

  const ext = path.extname(filePath).toLowerCase();
  const type = MIME[ext] || 'application/octet-stream';
  res.writeHead(200, { 'Content-Type': type, 'Cache-Control': ext === '.html' ? 'no-store' : 'public, max-age=31536000, immutable' });
  fs.createReadStream(filePath).pipe(res);
}

function proxyMedia(req, res) {
  try {
    const incoming = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
    const remote = (incoming.searchParams.get('url') || '').trim();
    if (!remote) {
      return send(res, 400, { error: { message: 'url query is required', type: 'invalid_request' } });
    }

    let target;
    try {
      target = new URL(remote);
    } catch {
      return send(res, 400, { error: { message: 'invalid media url', type: 'invalid_request' } });
    }

    if (!/^https?:$/i.test(target.protocol)) {
      return send(res, 400, { error: { message: 'only http/https media is allowed', type: 'invalid_request' } });
    }

    const isHttps = target.protocol === 'https:';
    const client = isHttps ? https : http;
    const headers = {
      // Some CDNs require a UA; keep it simple.
      'User-Agent': req.headers['user-agent'] || 'GrokStudioMediaProxy/1.0',
      Accept: req.headers.accept || '*/*'
    };
    if (req.headers.range) headers.Range = req.headers.range;

    const upstreamReq = client.request(
      {
        protocol: target.protocol,
        hostname: target.hostname,
        port: target.port || (isHttps ? 443 : 80),
        method: 'GET',
        path: `${target.pathname}${target.search}`,
        headers
      },
      (upstreamRes) => {
        const outHeaders = {
          'Access-Control-Allow-Origin': '*',
          'Cache-Control': 'private, max-age=300'
        };
        const pass = [
          'content-type',
          'content-length',
          'content-range',
          'accept-ranges',
          'content-disposition',
          'etag',
          'last-modified'
        ];
        for (const key of pass) {
          if (upstreamRes.headers[key]) outHeaders[key] = upstreamRes.headers[key];
        }
        // Encourage browser download when disposition missing.
        if (!outHeaders['content-disposition']) {
          const name = target.pathname.split('/').filter(Boolean).pop() || 'video.mp4';
          outHeaders['content-disposition'] = `inline; filename="${name}"`;
        }
        res.writeHead(upstreamRes.statusCode || 502, outHeaders);
        upstreamRes.pipe(res);
      }
    );

    upstreamReq.on('error', (error) => {
      if (!res.headersSent) {
        send(res, 502, {
          error: {
            message: error?.message || 'media proxy failed',
            type: 'studio_media_proxy_error'
          }
        });
      } else {
        res.end();
      }
    });
    upstreamReq.end();
  } catch (error) {
    return send(res, 500, {
      error: {
        message: error instanceof Error ? error.message : 'media proxy failed',
        type: 'studio_media_proxy_error'
      }
    });
  }
}

function proxyToUpstream(req, res, targetBase) {
  let target;
  try {
    target = new URL(targetBase);
  } catch {
    return send(res, 500, {
      error: {
        message: `Invalid proxy target: ${targetBase}`,
        type: 'studio_proxy_config_error'
      }
    });
  }

  const incoming = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
  const upstreamPath = incoming.pathname + incoming.search;
  const isHttps = target.protocol === 'https:';
  const client = isHttps ? https : http;

  const headers = { ...req.headers };
  // Upstream host must match target, not the studio origin.
  headers.host = target.host;
  // Avoid compressed edge cases while streaming through a simple proxy.
  delete headers['accept-encoding'];
  // Content-length will be re-calculated by request body pipe if needed.
  // Keep original content-length for non-chunked bodies.

  const options = {
    protocol: target.protocol,
    hostname: target.hostname,
    port: target.port || (isHttps ? 443 : 80),
    method: req.method,
    path: upstreamPath,
    headers
  };

  const upstreamReq = client.request(options, (upstreamRes) => {
    const outHeaders = { ...upstreamRes.headers };
    // Studio is same-origin to browser; no need to expose upstream ACAO.
    // But keep response clean for local use.
    res.writeHead(upstreamRes.statusCode || 502, outHeaders);
    upstreamRes.pipe(res);
  });

  upstreamReq.on('error', (error) => {
    send(res, 502, {
      error: {
        message: `Proxy upstream error: ${error.message}`,
        type: 'studio_proxy_upstream_error',
        target: targetBase
      }
    });
  });

  req.pipe(upstreamReq);
}

const server = http.createServer((req, res) => {
  const urlPath = req.url || '/';

  // Dynamic proxy target for this process. Can be overridden via env.
  // Browser stays same-origin: /v1/* => this server => upstream.
  if (urlPath.startsWith('/__proxy/media')) {
    if (req.method === 'OPTIONS') {
      res.writeHead(204, {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET,OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type, Range',
        'Access-Control-Max-Age': '86400'
      });
      return res.end();
    }
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      return send(res, 405, { error: { message: 'method not allowed' } });
    }
    return proxyMedia(req, res);
  }

  if (urlPath === '/__proxy/health') {
    return send(res, 200, {
      ok: true,
      mode: 'proxy',
      target: DEFAULT_TARGET,
      host: HOST,
      port: PORT
    });
  }

  if (urlPath.startsWith('/v1/') || urlPath === '/v1') {
    return proxyToUpstream(req, res, DEFAULT_TARGET);
  }

  // Preflight should not normally hit cross-origin here because browser is same-origin.
  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET,POST,PUT,PATCH,DELETE,OPTIONS,HEAD',
      'Access-Control-Allow-Headers': req.headers['access-control-request-headers'] || 'Authorization, Content-Type',
      'Access-Control-Max-Age': '86400'
    });
    return res.end();
  }

  return serveStatic(req, res);
});

server.listen(PORT, HOST, () => {
  console.log(`[grok-studio] http://${HOST}:${PORT}`);
  console.log(`[grok-studio] proxy /v1/* -> ${DEFAULT_TARGET}`);
  console.log(`[grok-studio] health  /__proxy/health`);
});
