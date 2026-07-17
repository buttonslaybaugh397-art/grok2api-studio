import type {
  AppConfig,
  ChatMessage,
  ImageResult,
  ModelItem,
  VideoGeneratePayload,
  VideoStatusResult
} from './types';

function normalizeBaseUrl(baseUrl: string) {
  let base = baseUrl.trim().replace(/\/+$/, '');
  if (/\/v1$/i.test(base)) {
    base = base.replace(/\/v1$/i, '');
  }
  return base;
}

export function resolveRequestBaseUrl(config: AppConfig) {
  // proxy mode: browser calls same-origin /v1 and /openai, local server forwards to CPA
  if ((config.connectionMode || 'proxy') !== 'direct') {
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

function authHeaders(apiKey: string, extra: HeadersInit = {}, proxyTarget?: string) {
  const headers: Record<string, string> = {
    Authorization: `Bearer ${apiKey.trim()}`,
    ...(extra as Record<string, string>)
  };
  if (proxyTarget) headers['X-Studio-Proxy-Target'] = proxyTarget;
  return headers;
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

async function requestJson<T>(config: AppConfig, path: string, init: RequestInit = {}): Promise<T> {
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
  if ((config.connectionMode || 'proxy') !== 'direct') {
    const target = String(config.proxyTarget || '').trim();
    if (target) headers.set('X-Studio-Proxy-Target', target);
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
      throw new Error('网络请求失败（常见原因是浏览器跨域 CORS）。请改用“本地代理”模式，或确认上游已开启 CORS。');
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
      return content.map((part: any) => part?.text || part?.content || '').filter(Boolean).join('');
    }
  }
  if (choice?.delta?.content) {
    return typeof choice.delta.content === 'string' ? choice.delta.content : '';
  }
  if (choice?.text) return String(choice.text);
  return '';
}

export async function fetchModels(config: AppConfig) {
  const raw = await requestJson<any>(config, '/v1/models', { method: 'GET' });
  const list: ModelItem[] = Array.isArray(raw?.data) ? raw.data : Array.isArray(raw) ? raw : [];
  return list
    .map((item: any) => ({
      id: String(item?.id || item?.name || '').trim(),
      object: item?.object,
      owned_by: item?.owned_by,
      created: item?.created
    }))
    .filter((item: ModelItem) => item.id);
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
      headers: {
        ...authHeaders(
          config.apiKey,
          {
            'Content-Type': 'application/json',
            Accept: 'text/event-stream'
          },
          (config.connectionMode || 'proxy') !== 'direct' ? config.proxyTarget : undefined
        )
      },
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
      throw new Error('网络请求失败（常见原因是浏览器跨域 CORS）。请改用“本地代理”模式，或确认上游已开启 CORS。');
    }
    throw error;
  }

  if (!response.ok) {
    throw new Error(await parseError(response));
  }
  if (!response.body) {
    throw new Error('上游未返回流式响应体');
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder('utf-8');
  let buffer = '';
  let full = '';
  const rawChunks: any[] = [];

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const parts = buffer.split(/\r?\n/);
    buffer = parts.pop() || '';
    for (const line of parts) {
      const trimmed = line.trim();
      if (!trimmed.startsWith('data:')) continue;
      const data = trimmed.slice(5).trim();
      if (!data || data === '[DONE]') continue;
      try {
        const json = JSON.parse(data);
        rawChunks.push(json);
        const delta =
          json?.choices?.[0]?.delta?.content ||
          json?.choices?.[0]?.message?.content ||
          json?.choices?.[0]?.text ||
          '';
        if (typeof delta === 'string' && delta) {
          full += delta;
          payload.onDelta(delta);
        }
      } catch {
        // ignore non-json sse lines
      }
    }
  }

  return { content: full, raw: rawChunks };
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
      response_format: payload.responseFormat || 'b64_json'
    })
  });
  return { created: raw.created, data: raw.data ?? [], raw } satisfies ImageResult;
}

function mapAspectRatioToSize(_aspectRatio?: string, resolution?: string) {
  const res = String(resolution || '').trim().toLowerCase();
  if (res === '1080p') return '1920x1080';
  if (res === '480p') return '848x480';
  return '1280x720';
}

function normalizeVideoSeconds(value: string | number | undefined, fallback = 4) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(1, Math.min(15, Math.round(n)));
}

export async function generateVideo(config: AppConfig, payload: VideoGeneratePayload) {
  const refs = (payload.referenceImageUrls || []).map((item) => String(item || '').trim()).filter(Boolean);
  const single = String(payload.imageUrl || '').trim();
  const all = Array.from(new Set([...(refs.length ? refs : []), ...(single ? [single] : [])]
    .map((item) => String(item || '').trim())
    .filter((url) => Boolean(url) && !url.startsWith('blob:'))))
    .slice(0, 7);

  // CPA/xAI: multi-reference duration is capped at 10s.
  let seconds = normalizeVideoSeconds(payload.seconds ?? payload.duration, 4);
  if (all.length > 1 && seconds > 10) seconds = 10;

  const size = payload.size || mapAspectRatioToSize(payload.aspectRatio, payload.resolution);

  const prompt = String(payload.prompt || '').trim();
  if (!prompt) {
    throw new Error('提示词(prompt)不能为空');
  }

  function buildBody(mode: 'openai' | 'native'): Record<string, unknown> {
    const body: Record<string, unknown> = {
      model: payload.model,
      prompt,
      seconds: String(seconds),
      size
    };
    if (payload.aspectRatio) body.aspect_ratio = payload.aspectRatio;
    if (payload.resolution) body.resolution = payload.resolution;
    if (mode === 'native') body.duration = seconds;

    // Exclusive image fields only.
    if (all.length === 1) {
      // Prefer input_reference for OpenAI-compatible path; native path also accepts it.
      if (payload.useInputReference === false) {
        body.image = { url: all[0] };
      } else {
        body.input_reference = { image_url: all[0] };
      }
    } else if (all.length > 1) {
      body.reference_images = all.map((url) => ({ url }));
    }
    return body;
  }

  if (all.length === 0 && (refs.length || single)) {
    throw new Error('参考图地址无效（仅支持 data: 或 http(s) 图片 URL）');
  }

  const attempts = [
    { path: '/v1/videos', body: buildBody('openai') },
    { path: '/v1/videos/generations', body: buildBody('native') }
  ];

  let lastError: Error | null = null;
  for (const attempt of attempts) {
    try {
      // Ensure prompt is still present after body construction.
      if (!String((attempt.body as any).prompt || '').trim()) {
        throw new Error('内部错误：请求体缺少 prompt');
      }
      const result = await requestJson<any>(config, attempt.path, {
        method: 'POST',
        body: JSON.stringify(attempt.body)
      });
      return {
        ...result,
        // echo for UI debugging without relying on upstream
        _studio_request: {
          path: attempt.path,
          prompt,
          referenceCount: all.length,
          hasInputReference: Boolean((attempt.body as any).input_reference),
          hasImage: Boolean((attempt.body as any).image),
          hasReferenceImages: Boolean((attempt.body as any).reference_images)
        }
      };
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      lastError = new Error(
        `${msg}（已发送 prompt 长度=${prompt.length}, 参考图=${all.length}, path=${attempt.path}）`
      );
    }
  }
  throw lastError || new Error('视频生成失败');
}

export async function fetchVideoStatus(config: AppConfig, requestId: string) {
  const raw = await requestJson<any>(config, `/v1/videos/${requestId}`, { method: 'GET' });
  const nestedVideo = raw?.video && typeof raw.video === 'object' ? raw.video : null;
  const url =
    nestedVideo?.url ||
    nestedVideo?.video_url ||
    nestedVideo?.download_url ||
    raw?.url ||
    raw?.output_url ||
    raw?.video_url ||
    raw?.download_url ||
    raw?.result?.url ||
    raw?.output?.url ||
    raw?.output?.video_url ||
    raw?.data?.url ||
    raw?.data?.video?.url ||
    '';

  const rawStatus = String(raw?.status || nestedVideo?.status || '').toLowerCase();
  let status = rawStatus;
  if (['completed', 'succeeded', 'success', 'complete', 'done'].includes(status)) status = 'done';
  else if (['error', 'canceled', 'cancelled', 'failed', 'expired'].includes(status)) status = 'failed';
  else if (['in_progress', 'processing', 'queued', 'running', 'submitted', 'pending'].includes(status)) status = 'pending';
  else if (!status) {
    // Only infer done from url when status is completely missing AND progress is 100.
    const progress = typeof raw?.progress === 'number' ? raw.progress : nestedVideo?.progress;
    status = url && progress === 100 ? 'done' : url ? 'pending' : 'pending';
  }

  const errorMessage =
    raw?.error?.message ||
    raw?.error_message ||
    (typeof raw?.error === 'string' ? raw.error : '') ||
    nestedVideo?.error ||
    '';

  const duration =
    nestedVideo?.duration ??
    raw?.duration ??
    raw?.seconds ??
    raw?.output?.duration ??
    undefined;

  return {
    // Always keep the requested task id. Do not let upstream swap in another id.
    id: requestId,
    status,
    output: raw?.output ?? nestedVideo,
    url: url || undefined,
    content_path:
      nestedVideo?.content_path ||
      nestedVideo?.content_url ||
      raw?.content_path ||
      raw?.content_url ||
      undefined,
    content_url:
      nestedVideo?.content_url ||
      nestedVideo?.content_path ||
      raw?.content_url ||
      raw?.content_path ||
      undefined,
    progress: typeof raw?.progress === 'number' ? raw.progress : undefined,
    duration,
    model: raw?.model || nestedVideo?.model || undefined,
    error: errorMessage || undefined,
    raw
  } satisfies VideoStatusResult;
}

export async function downloadVideoContent(config: AppConfig, videoId: string, filename = 'video.mp4') {
  const objectUrl = await fetchVideoObjectUrl(config, videoId);
  try {
    const anchor = document.createElement('a');
    anchor.href = objectUrl;
    const safeName = String(videoId || 'video').trim() || 'video';
    anchor.download = filename || (safeName + '.mp4');
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
  } finally {
    window.setTimeout(() => URL.revokeObjectURL(objectUrl), 1500);
  }
}

export async function fetchVideoObjectUrl(
  config: AppConfig,
  videoId: string,
  preferredPaths: string[] = []
): Promise<string> {
  if (!config.apiKey.trim()) throw new Error('请先填写 API Key');
  const id = String(videoId || '').trim();
  if (!id) throw new Error('缺少视频任务 ID');

  // Prefer gateway content relay first (native grok2api authenticated re-fetch),
  // then optional status-provided content paths, then CPA OpenAI-compatible path.
  const pathCandidates = [
    ...preferredPaths.map((item) => String(item || '').trim()).filter(Boolean),
    '/v1/videos/' + encodeURIComponent(id) + '/content',
    '/openai/v1/videos/' + encodeURIComponent(id) + '/content'
  ];
  const seen = new Set<string>();
  const candidates: string[] = [];
  for (const path of pathCandidates) {
    const url =
      path.startsWith('http://') || path.startsWith('https://')
        ? path
        : buildUrl(requestBase(config), path.startsWith('/') ? path : '/' + path);
    if (!seen.has(url)) {
      seen.add(url);
      candidates.push(url);
    }
  };

  let lastError: Error | null = null;
  for (const url of candidates) {
    try {
      const response = await fetch(url, {
        method: 'GET',
        headers: authHeaders(
          config.apiKey,
          {
            Accept: 'video/mp4,video/*;q=0.9,application/octet-stream;q=0.8,*/*;q=0.5',
            'Cache-Control': 'no-cache'
          },
          (config.connectionMode || 'proxy') !== 'direct' ? config.proxyTarget : undefined
        ),
        cache: 'no-store'
      });
      if (!response.ok) {
        throw new Error(await parseError(response));
      }
      const contentType = (response.headers.get('content-type') || '').toLowerCase();
      if (contentType.includes('application/json') || contentType.includes('text/')) {
        const text = await response.text();
        throw new Error(text.slice(0, 300) || 'CPA 返回了非视频内容');
      }
      const blob = await response.blob();
      if (!blob || blob.size < 1000) {
        throw new Error('视频内容为空或任务尚未可下载');
      }
      const typed =
        blob.type && blob.type.startsWith('video/')
          ? blob
          : new Blob([blob], { type: 'video/mp4' });
      return URL.createObjectURL(typed);
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));
    }
  }
  throw lastError || new Error('通过 CPA 获取视频内容失败');
}

export async function fetchRemoteVideoObjectUrl(remoteUrl: string): Promise<string> {
  const url = String(remoteUrl || '').trim();
  if (!url) throw new Error('缺少远程视频地址');
  if (url.startsWith('blob:') || url.startsWith('data:')) return url;

  const candidates = [mediaProxyUrl(url), url].filter(Boolean);
  let lastError: Error | null = null;
  for (const candidate of candidates) {
    try {
      const response = await fetch(candidate, {
        method: 'GET',
        headers: {
          Accept: 'video/mp4,video/*;q=0.9,application/octet-stream;q=0.8,*/*;q=0.5'
        }
      });
      if (!response.ok) {
        throw new Error(await parseError(response));
      }
      const blob = await response.blob();
      if (!blob || blob.size < 1000) {
        throw new Error('远程视频内容为空');
      }
      const typed =
        blob.type && blob.type.startsWith('video/')
          ? blob
          : new Blob([blob], { type: 'video/mp4' });
      return URL.createObjectURL(typed);
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));
    }
  }
  throw lastError || new Error('远程视频拉取失败');
}


export function cpaVideoContentPath(videoId: string, variant: 'openai' | 'native' = 'openai') {
  const id = String(videoId || '').trim();
  if (!id) return '';
  if (variant === 'native') {
    return '/v1/videos/' + encodeURIComponent(id) + '/content';
  }
  return '/openai/v1/videos/' + encodeURIComponent(id) + '/content';
}

export function toDataUrl(base64: string, mime = 'image/png') {
  const clean = String(base64 || '').replace(/^data:[^;]+;base64,/, '');
  return `data:${mime || 'image/png'};base64,${clean}`;
}

export function sniffImageMimeFromBase64(base64: string) {
  const clean = String(base64 || '').replace(/^data:[^;]+;base64,/, '').replace(/\s+/g, '');
  if (clean.startsWith('/9j/')) return 'image/jpeg';
  if (clean.startsWith('iVBOR')) return 'image/png';
  if (clean.startsWith('R0lGOD')) return 'image/gif';
  if (clean.startsWith('UklGR')) return 'image/webp';
  return 'image/png';
}

export async function fileToDataUrl(file: File | Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ''));
    reader.onerror = () => reject(new Error('读取本地图片失败'));
    reader.readAsDataURL(file);
  });
}

export async function probeImageMeta(src: string): Promise<{ width: number; height: number }> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve({ width: img.naturalWidth || 0, height: img.naturalHeight || 0 });
    img.onerror = () => reject(new Error('无法读取图片尺寸'));
    img.src = src;
  });
}

export function imageSrc(item: { url?: string; b64_json?: string }) {
  if (item.url) return item.url;
  if (item.b64_json) return toDataUrl(item.b64_json, sniffImageMimeFromBase64(item.b64_json));
  return '';
}

export function mediaProxyUrl(remoteUrl: string) {
  if (!remoteUrl) return '';
  if (remoteUrl.startsWith('blob:') || remoteUrl.startsWith('data:')) return remoteUrl;
  if (remoteUrl.startsWith('/__proxy/media')) return remoteUrl;
  // Only media proxy remains (API proxy is gone). Helps CDN playback with Referer.
  return `/__proxy/media?url=${encodeURIComponent(remoteUrl)}`;
}

export async function downloadRemoteFile(remoteUrl: string, filename: string) {
  if (!remoteUrl) throw new Error('没有可下载的地址');

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
