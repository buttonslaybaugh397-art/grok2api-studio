/**
 * Static + reverse-proxy server for Grok Studio.
 * - Serves dist/
 * - Proxies /v1/* and /openai/* to CPA so browser same-origin requests appear on CPA
 * - Media proxy for CDN playback
 *
 * Usage:
 *   node server.mjs
 *   set STUDIO_PROXY_TARGET=http://154.201.92.160:8000 && node server.mjs
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
    filePath = path.join(DIST_DIR, 'index.html');
  }

  const ext = path.extname(filePath).toLowerCase();
  const type = MIME[ext] || 'application/octet-stream';
  res.writeHead(200, {
    'Content-Type': type,
    'Cache-Control': ext === '.html' ? 'no-store' : 'public, max-age=31536000, immutable'
  });
  fs.createReadStream(filePath).pipe(res);
}

function resolveProxyTarget(req) {
  const headerTarget = String(req.headers['x-studio-proxy-target'] || '').trim();
  if (/^https?:\/\//i.test(headerTarget)) {
    return headerTarget.replace(/\/+$/, '');
  }
  return DEFAULT_TARGET.replace(/\/+$/, '');
}

function proxyToUpstream(req, res, targetBase) {
  let target;
  try {
    target = new URL(targetBase);
  } catch {
    return send(res, 500, {
      error: {
        message: `Invalid proxy target: ${targetBase}`,
        type: 'studio_proxy_invalid_target'
      }
    });
  }

  const isHttps = target.protocol === 'https:';
  const client = isHttps ? https : http;
  const incoming = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
  const upstreamPath = `${incoming.pathname}${incoming.search}`;

  const headers = { ...req.headers };
  // rewrite host to upstream
  headers.host = target.host;
  delete headers['accept-encoding'];
  // hop-by-hop / local-only headers
  delete headers['x-studio-proxy-target'];
  delete headers['connection'];
  delete headers['content-length'];

  console.log(`[grok-studio] proxy ${req.method} ${upstreamPath} -> ${targetBase}`);

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
    // Ensure browser can read response from same origin freely.
    outHeaders['access-control-allow-origin'] = '*';
    res.writeHead(upstreamRes.statusCode || 502, outHeaders);
    upstreamRes.pipe(res);
  });

  upstreamReq.on('error', (error) => {
    console.error('[grok-studio] upstream error', error.message);
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
      'User-Agent':
        req.headers['user-agent'] ||
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
      Accept: req.headers.accept || 'video/mp4,video/*;q=0.9,*/*;q=0.8',
      'Accept-Language': 'en-US,en;q=0.9',
      Referer: 'https://grok.com/',
      Origin: 'https://grok.com'
    };
    if (req.headers.range) headers.Range = req.headers.range;

    const upstreamReq = client.request(
      {
        protocol: target.protocol,
        hostname: target.hostname,
        port: target.port || (isHttps ? 443 : 80),
        method: req.method || 'GET',
        path: `${target.pathname}${target.search}`,
        headers
      },
      (upstreamRes) => {
        const outHeaders = {
          'Access-Control-Allow-Origin': '*',
          'Cache-Control': 'private, max-age=300'
        };
        for (const key of [
          'content-type',
          'content-length',
          'content-range',
          'accept-ranges',
          'content-disposition',
          'etag',
          'last-modified'
        ]) {
          if (upstreamRes.headers[key]) outHeaders[key] = upstreamRes.headers[key];
        }
        if (!outHeaders['content-type']) outHeaders['Content-Type'] = 'video/mp4';
        res.writeHead(upstreamRes.statusCode || 502, outHeaders);
        if ((req.method || 'GET').toUpperCase() === 'HEAD') {
          res.end();
          return;
        }
        upstreamRes.pipe(res);
      }
    );

    upstreamReq.on('error', (error) => {
      send(res, 502, {
        error: {
          message: `Media proxy upstream error: ${error.message}`,
          type: 'studio_media_proxy_error'
        }
      });
    });
    upstreamReq.end();
  } catch (error) {
    send(res, 500, {
      error: {
        message: error instanceof Error ? error.message : String(error),
        type: 'studio_media_proxy_error'
      }
    });
  }
}

const server = http.createServer((req, res) => {
  const urlPath = req.url || '/';

  if (urlPath.startsWith('/__proxy/media')) {
    if (req.method === 'OPTIONS') {
      res.writeHead(204, {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET,HEAD,OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type, Range, Authorization, X-Studio-Proxy-Target',
        'Access-Control-Max-Age': '86400'
      });
      return res.end();
    }
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      return send(res, 405, { error: { message: 'method not allowed' } });
    }
    return proxyMedia(req, res);
  }

  if (urlPath === '/__proxy/health' || urlPath.startsWith('/__proxy/health?')) {
    return send(res, 200, {
      ok: true,
      mode: 'static+api-proxy+media-proxy',
      apiProxy: true,
      mediaProxy: true,
      target: DEFAULT_TARGET,
      host: HOST,
      port: PORT,
      note: 'Browser should use proxy mode (empty baseUrl). Requests to /v1/* and /openai/* are forwarded to CPA.'
    });
  }

  // API reverse proxy — this is what makes calls visible on CPA.
  if (
    urlPath.startsWith('/v1/') ||
    urlPath === '/v1' ||
    urlPath.startsWith('/openai/') ||
    urlPath === '/openai'
  ) {
    if (req.method === 'OPTIONS') {
      res.writeHead(204, {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET,POST,PUT,PATCH,DELETE,OPTIONS,HEAD',
        'Access-Control-Allow-Headers':
          req.headers['access-control-request-headers'] ||
          'Authorization, Content-Type, X-Studio-Proxy-Target',
        'Access-Control-Max-Age': '86400'
      });
      return res.end();
    }
    return proxyToUpstream(req, res, resolveProxyTarget(req));
  }

  return serveStatic(req, res);
});

server.listen(PORT, HOST, () => {
  console.log(`[grok-studio] http://${HOST}:${PORT}`);
  console.log(`[grok-studio] proxy /v1/* and /openai/* -> ${DEFAULT_TARGET}`);
  console.log(`[grok-studio] health  /__proxy/health`);
});
