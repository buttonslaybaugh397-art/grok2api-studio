import type {
  AppConfig,
  ChatMessage,
  ImageResult,
  ModelItem,
  VideoStatusResult
} from './types';

function normalizeBaseUrl(baseUrl: string) {
  let base = baseUrl.trim().replace(/\/+$/, '');
  // Users often paste ".../v1". Paths already include /v1/...
  if (/\/v1$/i.test(base)) {
    base = base.replace(/\/v1$/i, '');
  }
  return base;
}

/**
 * CORS strategy for the standalone Studio:
 * - proxy mode: always call same-origin /v1/* (local reverse proxy forwards upstream)
 * - direct mode: call config.baseUrl directly (requires upstream CORS)
 */
export function resolveRequestBaseUrl(config: AppConfig) {
  if ((config.connectionMode || 'proxy') === 'proxy') {
    return '';
  }
  return normalizeBaseUrl(config.baseUrl);
}

function buildUrl(baseUrl: string, path: string) {
  const cleanPath = path.startsWith('/') ? path : `/${path}`;
  const base = normalizeBaseUrl(baseUrl);
  return base ? `${base}${cleanPath}` : cleanPath;
}

function requestBase(config: AppConfig) {
  return resolveRequestBaseUrl(config);
}

function authHeaders(apiKey: string, extra: HeadersInit = {}) {
  return {
    Authorization: `Bearer ${apiKey.trim()}`,
    ...extra
  };
}

async function parseError(response: Response) {
  const text = await response.text();
  try {
    const json = JSON.parse(text);
    return json?.error?.message || json?.message || text || `HTTP ${response.status}`;
  } catch {
    return text || `HTTP ${response.status}`;
  }
}

async function requestJson<T>(
  config: AppConfig,
  path: string,
  init: RequestInit = {}
): Promise<T> {
  if (!config.apiKey.trim()) {
    throw new Error('请先填写 API Key');
  }

  const headers = new Headers(init.headers || {});
  if (!headers.has('Authorization')) {
    headers.set('Authorization', `Bearer ${config.apiKey.trim()}`);
  }
  if (init.body && !headers.has('Content-Type')) {
    headers.set('Content-Type', 'application/json');
  }

  let response: Response;
  try {
    response = await fetch(buildUrl(requestBase(config), path), {
      ...init,
      headers
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (/Failed to fetch|NetworkError|CORS/i.test(message)) {
      throw new Error(
        '网络请求失败（常见原因是浏览器跨域 CORS）。请改用“本地代理”模式，或确认上游已开启 CORS。'
      );
    }
    throw error;
  }

  if (!response.ok) {
    throw new Error(await parseError(response));
  }

  if (response.status === 204) {
    return {} as T;
  }

  return response.json() as Promise<T>;
}

function extractText(payload: any): string {
  if (!payload) return '';
  if (typeof payload === 'string') return payload;
  if (typeof payload.output_text === 'string') return payload.output_text;
  if (typeof payload.text === 'string') return payload.text;
  if (typeof payload.content === 'string') return payload.content;

  const choice = payload.choices?.[0];
  if (choice?.message?.content) {
    const content = choice.message.content;
    if (typeof content === 'string') return content;
    if (Array.isArray(content)) {
      return content
        .map((part: any) => part?.text || part?.content || '')
        .filter(Boolean)
        .join('\n');
    }
  }

  if (Array.isArray(payload.output)) {
    return payload.output
      .flatMap((item: any) => item?.content || [])
      .map((part: any) => part?.text || part?.content || '')
      .filter(Boolean)
      .join('\n');
  }

  return '';
}

export async function fetchModels(config: AppConfig) {
  const raw = await requestJson<any>(config, '/v1/models', { method: 'GET' });
  const list = Array.isArray(raw?.data) ? raw.data : Array.isArray(raw) ? raw : [];
  return list
    .map((item: any) => ({
      id: item.id || item.model || item.name || '',
      object: item.object,
      owned_by: item.owned_by,
      created: item.created
    }))
    .filter((item: ModelItem) => Boolean(item.id)) as ModelItem[];
}

export async function streamChat(
  config: AppConfig,
  payload: {
    model: string;
    messages: ChatMessage[];
    temperature?: number;
    maxTokens?: number;
    signal?: AbortSignal;
    onDelta: (delta: string) => void;
  }
) {
  if (!config.apiKey.trim()) {
    throw new Error('请先填写 API Key');
  }

  let response: Response;
  try {
    response = await fetch(buildUrl(requestBase(config), '/v1/chat/completions'), {
      method: 'POST',
      headers: authHeaders(config.apiKey, { 'Content-Type': 'application/json' }),
      body: JSON.stringify({
        model: payload.model,
        messages: payload.messages,
        stream: true,
        temperature: payload.temperature ?? 0.7,
        max_tokens: payload.maxTokens || undefined
      }),
      signal: payload.signal
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (/Failed to fetch|NetworkError|CORS/i.test(message)) {
      throw new Error(
        '流式请求失败（常见原因是浏览器跨域 CORS）。请改用“本地代理”模式，或确认上游已开启 CORS。'
      );
    }
    throw error;
  }

  if (!response.ok) {
    throw new Error(await parseError(response));
  }

  if (!response.body) {
    const raw = await response.json();
    const content = extractText(raw);
    if (content) payload.onDelta(content);
    return { content, raw };
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder('utf-8');
  let buffer = '';
  let content = '';
  let lastPayload: any = null;

  const handleEvent = (chunk: string) => {
    const lines = chunk.split(/\r?\n/);
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed.startsWith('data:')) continue;
      const data = trimmed.slice(5).trim();
      if (!data || data === '[DONE]') continue;
      try {
        const json = JSON.parse(data);
        lastPayload = json;
        const delta =
          json.choices?.[0]?.delta?.content ||
          json.choices?.[0]?.message?.content ||
          json.delta?.content ||
          '';
        if (typeof delta === 'string' && delta) {
          content += delta;
          payload.onDelta(delta);
        }
      } catch {
        // ignore partial json
      }
    }
  };

  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let boundary = buffer.search(/\r?\n\r?\n/);
    while (boundary !== -1) {
      const event = buffer.slice(0, boundary);
      buffer = buffer.slice(boundary).replace(/^\r?\n\r?\n/, '');
      handleEvent(event);
      boundary = buffer.search(/\r?\n\r?\n/);
    }
  }

  if (buffer.trim()) handleEvent(buffer);
  if (!content && lastPayload) content = extractText(lastPayload);
  return { content, raw: lastPayload };
}

export async function generateChat(
  config: AppConfig,
  payload: {
    model: string;
    messages: ChatMessage[];
    temperature?: number;
    maxTokens?: number;
  }
) {
  const raw = await requestJson<any>(config, '/v1/chat/completions', {
    method: 'POST',
    body: JSON.stringify({
      model: payload.model,
      messages: payload.messages,
      stream: false,
      temperature: payload.temperature ?? 0.7,
      max_tokens: payload.maxTokens || undefined
    })
  });
  return { content: extractText(raw), raw };
}

export async function generateImage(
  config: AppConfig,
  payload: {
    model: string;
    prompt: string;
    n: number;
    size?: string;
    aspectRatio?: string;
    responseFormat?: 'url' | 'b64_json';
  }
) {
  const raw = await requestJson<any>(config, '/v1/images/generations', {
    method: 'POST',
    body: JSON.stringify({
      model: payload.model,
      prompt: payload.prompt,
      n: payload.n,
      size: payload.size || undefined,
      aspect_ratio: payload.aspectRatio || undefined,
      response_format: payload.responseFormat || 'url'
    })
  });
  return { created: raw.created, data: raw.data ?? [], raw } satisfies ImageResult;
}

export async function generateVideo(
  config: AppConfig,
  payload: {
    model: string;
    prompt: string;
    duration: string | number;
    aspectRatio: string;
    resolution: string;
  }
) {
  const durationValue = Number(payload.duration);
  return requestJson<any>(config, '/v1/videos/generations', {
    method: 'POST',
    body: JSON.stringify({
      model: payload.model,
      prompt: payload.prompt,
      duration: Number.isFinite(durationValue) ? durationValue : 8,
      aspect_ratio: payload.aspectRatio || undefined,
      resolution: payload.resolution || undefined
    })
  });
}

export async function fetchVideoStatus(config: AppConfig, requestId: string) {
  const raw = await requestJson<any>(config, `/v1/videos/${requestId}`, { method: 'GET' });
  const nestedVideo = raw?.video && typeof raw.video === 'object' ? raw.video : null;
  const url =
    nestedVideo?.url ||
    raw?.url ||
    raw?.output_url ||
    raw?.video_url ||
    raw?.output?.url ||
    raw?.data?.url ||
    '';

  // Official grok2api shape uses pending | done | failed.
  const rawStatus = String(raw?.status || nestedVideo?.status || '').toLowerCase();
  let status = rawStatus || (url ? 'done' : 'pending');
  if (['completed', 'succeeded', 'success', 'complete'].includes(status)) status = 'done';
  if (['error', 'canceled', 'cancelled'].includes(status)) status = 'failed';
  if (['in_progress', 'processing', 'queued', 'running', 'submitted'].includes(status)) status = 'pending';

  const errorMessage =
    raw?.error?.message ||
    raw?.error_message ||
    (typeof raw?.error === 'string' ? raw.error : '') ||
    nestedVideo?.error ||
    '';

  return {
    id: raw?.id ?? raw?.request_id ?? requestId,
    status,
    output: raw?.output ?? nestedVideo,
    url: url || undefined,
    progress: typeof raw?.progress === 'number' ? raw.progress : undefined,
    error: errorMessage || undefined,
    raw
  } satisfies VideoStatusResult;
}

export function toDataUrl(base64: string) {
  return `data:image/png;base64,${base64}`;
}

export function imageSrc(item: { url?: string; b64_json?: string }) {
  if (item.url) return item.url;
  if (item.b64_json) return toDataUrl(item.b64_json);
  return '';
}

/** Same-origin media proxy to avoid CORS when downloading remote video/image assets. */
export function mediaProxyUrl(remoteUrl: string) {
  if (!remoteUrl) return '';
  if (remoteUrl.startsWith('blob:') || remoteUrl.startsWith('data:')) return remoteUrl;
  return `/__proxy/media?url=${encodeURIComponent(remoteUrl)}`;
}

export async function downloadRemoteFile(remoteUrl: string, filename: string) {
  if (!remoteUrl) throw new Error('没有可下载的地址');

  // Prefer same-origin media proxy first to avoid browser CORS blocking blob download.
  const candidates: string[] = [];
  if (/^https?:\/\//i.test(remoteUrl)) {
    candidates.push(mediaProxyUrl(remoteUrl));
  }
  candidates.push(remoteUrl);

  let lastError: Error | null = null;
  for (const source of candidates) {
    try {
      const response = await fetch(source, { method: 'GET' });
      if (!response.ok) {
        throw new Error(`下载失败 HTTP ${response.status}`);
      }
      const blob = await response.blob();
      const objectUrl = URL.createObjectURL(blob);
      const anchor = document.createElement('a');
      anchor.href = objectUrl;
      anchor.download = filename || 'video.mp4';
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
      window.setTimeout(() => URL.revokeObjectURL(objectUrl), 1500);
      return;
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));
    }
  }

  throw lastError || new Error('下载失败');
}

