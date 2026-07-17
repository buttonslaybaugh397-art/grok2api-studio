import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import {
  downloadRemoteFile,
  downloadVideoContent,
  fetchVideoObjectUrl,
  fetchRemoteVideoObjectUrl,
  mediaProxyUrl,
  fetchModels,
  fetchVideoStatus,
  fileToDataUrl,
  generateChat,
  generateImage,
  generateVideo,
  imageSrc,
  probeImageMeta,
  streamChat,
  sniffImageMimeFromBase64
} from './api';
import type {
  AppConfig,
  ModelItem,
  StudioConversation,
  StudioMessage,
  StudioMode,
  VideoReferenceImage,
  VideoReferenceSource
} from './types';

const CONFIG_KEY = 'grok-studio-config-v2';
const HISTORY_KEY = 'grok-studio-history-v2';
const MAX_HISTORY_CONVERSATIONS = 40;
const MAX_HISTORY_MESSAGES = 80;

function sanitizeMessageForStorage(message: StudioMessage): StudioMessage {
  const next: StudioMessage = {
    ...message,
    content: typeof message.content === 'string' ? message.content.slice(0, 8000) : '',
    error: message.error ? String(message.error).slice(0, 1000) : undefined,
    raw: undefined
  };

  if (Array.isArray(message.images)) {
    next.images = message.images.slice(0, 8).map((img: any) => {
      const url = typeof img?.url === 'string' ? img.url : '';
      // Never persist huge base64 payloads into localStorage.
      if (url.startsWith('data:')) {
        return { url: url.slice(0, 120) + '...', revised_prompt: img?.revised_prompt };
      }
      return {
        url: url.slice(0, 2000),
        revised_prompt: img?.revised_prompt
      };
    });
  }

  if (message.video) {
    next.video = {
      id: message.video.id,
      status: message.video.status,
      url: message.video.url && !String(message.video.url).startsWith('data:')
        ? String(message.video.url).slice(0, 2000)
        : undefined,
      progress: message.video.progress,
      duration: message.video.duration
    };
  }

  return next;
}

function sanitizeConversationForStorage(item: StudioConversation): StudioConversation {
  return {
    ...item,
    title: String(item.title || '').slice(0, 120),
    messages: (item.messages || []).slice(-MAX_HISTORY_MESSAGES).map(sanitizeMessageForStorage)
  };
}

function persistHistory(conversations: StudioConversation[]) {
  try {
    const compact = conversations
      .slice(0, MAX_HISTORY_CONVERSATIONS)
      .map(sanitizeConversationForStorage);
    localStorage.setItem(HISTORY_KEY, JSON.stringify(compact));
  } catch (error) {
    // Quota or private mode should never crash the page.
    console.warn('persist history failed', error);
    try {
      // Last resort: keep only lightweight stubs.
      const stubs = conversations.slice(0, 10).map((item) => ({
        ...item,
        messages: (item.messages || []).slice(-10).map((message) => ({
          id: message.id,
          role: message.role,
          mode: message.mode,
          content: String(message.content || '').slice(0, 500),
          status: message.status,
          createdAt: message.createdAt,
          video: message.video
            ? { id: message.video.id, status: message.video.status, url: message.video.url }
            : undefined
        }))
      }));
      localStorage.setItem(HISTORY_KEY, JSON.stringify(stubs));
    } catch {
      // ignore
    }
  }
}


const DEFAULT_PROXY_TARGET = (import.meta as ImportMeta & {
  env?: { VITE_DEV_PROXY_TARGET?: string; VITE_API_BASE_URL?: string };
}).env?.VITE_DEV_PROXY_TARGET?.trim()
  || (import.meta as ImportMeta & { env?: { VITE_API_BASE_URL?: string } }).env?.VITE_API_BASE_URL?.trim()
  || 'http://154.201.92.160:8000';

const defaultConfig: AppConfig = {
  // empty baseUrl in proxy mode => same-origin requests via local reverse proxy
  baseUrl: '',
  apiKey: '',
  connectionMode: 'proxy',
  proxyTarget: DEFAULT_PROXY_TARGET
};

const modeMeta: Record<
  StudioMode,
  { label: string; endpoint: string; preferred: string; placeholder: string; hint: string }
> = {
  chat: {
    label: '对话',
    endpoint: 'POST /v1/chat/completions',
    preferred: 'grok-composer-2.5-fast',
    placeholder: '输入消息，Enter 发送，Shift+Enter 换行',
    hint: '支持流式对话与系统提示词'
  },
  image: {
    label: '图片',
    endpoint: 'POST /v1/images/generations',
    preferred: 'grok-imagine-image',
    placeholder: '描述你想生成的图片构图、风格与细节...',
    hint: '结果会进入当前会话消息流'
  },
  video: {
    label: '视频',
    endpoint: 'POST /v1/videos',
    preferred: 'grok-imagine-video',
    placeholder: '描述镜头、主体、运动与氛围。可叠加参考图，或开启“先出图再生视频”...',
    hint: '支持文生视频 / 图生视频 / 先出图再生视频'
  }
};

function uid(prefix = 'id') {
  return `${prefix}_${Math.random().toString(36).slice(2, 10)}_${Date.now().toString(36)}`;
}

function loadConfig(): AppConfig {
  try {
    const saved = JSON.parse(localStorage.getItem(CONFIG_KEY) || '{}') || {};
    const proxyTarget = String(saved.proxyTarget || saved.baseUrl || defaultConfig.proxyTarget || '').trim()
      || 'http://154.201.92.160:8000';
    // Force proxy by default so requests always hit CPA via local reverse proxy and appear in CPA logs.
    // Direct mode remains available only if user explicitly saved connectionMode=direct AND baseUrl is http(s).
    const wantDirect = saved.connectionMode === 'direct' && /^https?:\/\//i.test(String(saved.baseUrl || '').trim());
    if (wantDirect) {
      return {
        ...defaultConfig,
        connectionMode: 'direct',
        baseUrl: String(saved.baseUrl || '').trim(),
        proxyTarget,
        apiKey: String(saved.apiKey || '').trim()
      };
    }
    return {
      ...defaultConfig,
      connectionMode: 'proxy',
      baseUrl: '',
      proxyTarget,
      apiKey: String(saved.apiKey || '').trim()
    };
  } catch {
    return defaultConfig;
  }
}

function loadHistory(): StudioConversation[] {
  try {
    const data = JSON.parse(localStorage.getItem(HISTORY_KEY) || '[]');
    return Array.isArray(data) ? data : [];
  } catch {
    return [];
  }
}

function createConversation(mode: StudioMode, model: string): StudioConversation {
  const now = Date.now();
  return {
    id: uid('conv'),
    title: '新对话',
    mode,
    model,
    createdAt: now,
    updatedAt: now,
    messages: []
  };
}

function classifyModel(id: string): StudioMode {
  const value = id.toLowerCase();
  // Strict priority: video first, then image, otherwise chat/text.
  if (
    value.includes('video') ||
    value.includes('sora') ||
    value.includes('kling') ||
    value.includes('runway')
  ) {
    return 'video';
  }
  if (
    value.includes('image') ||
    value.includes('dall') ||
    value.includes('flux') ||
    value.includes('diffusion') ||
    /(^|[-_])sd(xl)?($|[-_])/.test(value) ||
    value.includes('imagine-image')
  ) {
    return 'image';
  }
  return 'chat';
}

function matchModels(models: ModelItem[], mode: StudioMode) {
  return models.filter((item) => classifyModel(item.id) === mode);
}

function pickModel(models: ModelItem[], preferred: string, mode: StudioMode) {
  const matched = matchModels(models, mode);
  const pool = matched.length > 0 ? matched : models;
  const preferredForMode = modeMeta[mode].preferred;

  if (
    preferred &&
    pool.some((item) => item.id === preferred) &&
    (matched.length === 0 || classifyModel(preferred) === mode)
  ) {
    return preferred;
  }
  if (pool.some((item) => item.id === preferredForMode)) {
    return preferredForMode;
  }

  // Prefer more specific native models when available.
  if (mode === 'video') {
    const exact = pool.find((item) => item.id.toLowerCase().includes('imagine-video'));
    if (exact) return exact.id;
  }
  if (mode === 'image') {
    const exact = pool.find((item) => /imagine-image(?!-edit)/i.test(item.id));
    if (exact) return exact.id;
  }
  if (mode === 'chat') {
    const composer = pool.find((item) => item.id.toLowerCase().includes('composer'));
    if (composer) return composer.id;
    const chat = pool.find((item) => item.id.toLowerCase().includes('chat'));
    if (chat) return chat.id;
  }

  return pool[0]?.id || preferredForMode || preferred || '';
}

function titleFromContent(content: string) {
  const text = content.replace(/\s+/g, ' ').trim();
  if (!text) return '新对话';
  return text.length > 24 ? `${text.slice(0, 24)}...` : text;
}

function formatTime(value: number) {
  try {
    return new Date(value).toLocaleString('zh-CN', {
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit'
    });
  } catch {
    return '';
  }
}

function statusLabel(status: StudioMessage['status']) {
  if (status === 'streaming') return '生成中';
  if (status === 'pending') return '处理中';
  if (status === 'error') return '失败';
  return '完成';
}

async function copyText(text: string) {
  if (!text) return;
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    const area = document.createElement('textarea');
    area.value = text;
    document.body.appendChild(area);
    area.select();
    document.execCommand('copy');
    document.body.removeChild(area);
  }
}

function guessVideoFilename(url: string, requestId?: string) {
  try {
    const pathname = new URL(url).pathname;
    const base = pathname.split('/').filter(Boolean).pop() || '';
    if (base && /\.[a-z0-9]{2,5}$/i.test(base)) {
      return decodeURIComponent(base);
    }
  } catch {
    // ignore invalid url
  }
  const id = (requestId || 'video').replace(/[^a-zA-Z0-9_-]/g, '_');
  return `${id}.mp4`;
}

function resolvePlayableVideoUrl(url?: string, cpaObjectUrl?: string, allowRemoteFallback = false) {
  if (cpaObjectUrl) return cpaObjectUrl;
  if (!url) return '';
  if (url.startsWith('blob:') || url.startsWith('data:')) return url;
  if (url.startsWith('/__proxy/media')) return url;
  // Prefer CPA blob first; remote fallback goes through media proxy for CDN compatibility.
  if (!allowRemoteFallback) return '';
  return mediaProxyUrl(url) || url;
}

export default function App() {
  const [config, setConfig] = useState<AppConfig>(() => loadConfig());
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [models, setModels] = useState<ModelItem[]>([]);
  const [modelError, setModelError] = useState('');
  const [modelNotice, setModelNotice] = useState('');
  const [modelLoading, setModelLoading] = useState(false);
  const [mode, setMode] = useState<StudioMode>('chat');
  const [model, setModel] = useState('grok-composer-2.5-fast');
  const [systemPrompt, setSystemPrompt] = useState('你是一名专业、准确、表达清晰的 AI 助手。');
  const [temperature, setTemperature] = useState(0.7);
  const [maxTokens, setMaxTokens] = useState(2048);
  const [streamEnabled, setStreamEnabled] = useState(true);
  const [imageCount, setImageCount] = useState(1);
  const [imageSize, setImageSize] = useState('1024x1024');
  const [videoDuration, setVideoDuration] = useState('4');
  const [videoAspectRatio, setVideoAspectRatio] = useState('16:9');
  const [videoResolution, setVideoResolution] = useState('720p');
  const [videoRefs, setVideoRefs] = useState<VideoReferenceImage[]>([]);
  const [videoRefUrlInput, setVideoRefUrlInput] = useState('');
  const [videoRefSource, setVideoRefSource] = useState<VideoReferenceSource>('none');
  const [videoPipelineEnabled, setVideoPipelineEnabled] = useState(false);
  const [pipelineImageModel, setPipelineImageModel] = useState('grok-imagine-image');
  const [pipelineImageSize, setPipelineImageSize] = useState('1024x1024');
  const [videoUseInputReference, setVideoUseInputReference] = useState(true);
  const [refBusy, setRefBusy] = useState(false);
  const [assetPickerOpen, setAssetPickerOpen] = useState(false);
  const [mentionOpen, setMentionOpen] = useState(false);
  const [mentionQuery, setMentionQuery] = useState('');
  const [mentionStart, setMentionStart] = useState(-1);
  const [mentionIndex, setMentionIndex] = useState(0);
  const [mentionAssetMap, setMentionAssetMap] = useState<Record<string, VideoReferenceImage>>({});
  const [refStackExpanded, setRefStackExpanded] = useState(false);
  const refFileInputRef = useRef<HTMLInputElement | null>(null);
  const composerTextareaRef = useRef<HTMLTextAreaElement | null>(null);
  const [composer, setComposer] = useState('');
  const [sending, setSending] = useState(false);
  const [error, setError] = useState('');
  const [toast, setToast] = useState('');
  const [query, setQuery] = useState('');
  const [conversations, setConversations] = useState<StudioConversation[]>(() => {
    const history = loadHistory();
    return history.length > 0 ? history : [createConversation('chat', 'grok-composer-2.5-fast')];
  });
  const [activeId, setActiveId] = useState(() => {
    const history = loadHistory();
    return history[0]?.id || '';
  });
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [previewImage, setPreviewImage] = useState('');
  const [previewVideo, setPreviewVideo] = useState('');
  const [videoObjectUrls, setVideoObjectUrls] = useState<Record<string, string>>({});
  const videoObjectUrlsRef = useRef<Record<string, string>>({});
  const activeVideoRequestIdRef = useRef<string>('');
  const [downloadingVideoId, setDownloadingVideoId] = useState('');
  const abortRef = useRef<AbortController | null>(null);
  const listRef = useRef<HTMLDivElement | null>(null);
  const autoFetchedRef = useRef(false);

  const active = useMemo(
    () => conversations.find((item) => item.id === activeId) || conversations[0] || null,
    [conversations, activeId]
  );

  const hasApiKey = Boolean(config.apiKey.trim());
  const canRequest =
    hasApiKey &&
    (config.connectionMode === 'direct'
      ? Boolean(config.baseUrl.trim()) && /^https?:\/\//i.test(config.baseUrl.trim())
      : Boolean((config.proxyTarget || DEFAULT_PROXY_TARGET || '').trim()));
  const matchedModels = useMemo(() => matchModels(models, mode), [models, mode]);
  const modeModels = matchedModels.length > 0 ? matchedModels : models;
  const usingFallbackModels = models.length > 0 && matchedModels.length === 0;

  const filteredConversations = useMemo(() => {
    const keyword = query.trim().toLowerCase();
    if (!keyword) return conversations;
    return conversations.filter((item) => {
      const haystack = `${item.title} ${item.model} ${item.mode}`.toLowerCase();
      return haystack.includes(keyword);
    });
  }, [conversations, query]);

  useEffect(() => {
    localStorage.setItem(CONFIG_KEY, JSON.stringify(config));
  }, [config]);

  useEffect(() => {
    persistHistory(conversations);
  }, [conversations]);

  useEffect(() => {
    if (!activeId && conversations[0]) setActiveId(conversations[0].id);
  }, [activeId, conversations]);

  useEffect(() => {
    if (listRef.current) {
      listRef.current.scrollTop = listRef.current.scrollHeight;
    }
  }, [active?.messages, sending]);

  useEffect(() => {
    if (!toast) return;
    const timer = window.setTimeout(() => setToast(''), 2200);
    return () => window.clearTimeout(timer);
  }, [toast]);

  useEffect(() => {
    if (!canRequest || autoFetchedRef.current) return;
    autoFetchedRef.current = true;
    void refreshModels(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [canRequest]);

  useEffect(() => {
    setModel((current) => {
      if (!models.length) {
        // Keep a mode-native default even before models are loaded.
        return modeMeta[mode].preferred || current;
      }
      return pickModel(models, current, mode);
    });
  }, [mode, models]);

  function showToast(message: string) {
    setToast(message);
  }

  function updateConversation(id: string, updater: (item: StudioConversation) => StudioConversation) {
    setConversations((current) => current.map((item) => (item.id === id ? updater(item) : item)));
  }

  function ensureConversation() {
    if (active) return active;
    const created = createConversation(mode, model);
    setConversations((current) => [created, ...current]);
    setActiveId(created.id);
    return created;
  }

  async function refreshModels(silent = false) {
    if (!canRequest) {
      setModelError('请先填写 API Key，并确认地址格式正确。');
      if (!silent) setSettingsOpen(true);
      return;
    }

    setModelLoading(true);
    setModelError('');
    setModelNotice('');
    try {
      const result = await fetchModels(config);
      setModels(result);
      if (result.length === 0) {
        setModelError('当前 Key 没有可用模型，或上游账号尚未同步。');
      } else {
        const nextModel = pickModel(result, model, mode);
        setModel(nextModel);
        setModelNotice(`已加载 ${result.length} 个模型`);
        if (!silent) showToast(`已获取 ${result.length} 个模型`);
      }
    } catch (requestError) {
      setModels([]);
      setModelError(requestError instanceof Error ? requestError.message : '获取模型失败');
    } finally {
      setModelLoading(false);
    }
  }

  function createNewConversation() {
    const nextModel = models.length ? pickModel(models, model, mode) : modeMeta[mode].preferred || model;
    setModel(nextModel);
    const created = createConversation(mode, nextModel);
    setConversations((current) => [created, ...current]);
    setActiveId(created.id);
    setComposer('');
    setError('');
  }

  function deleteConversation(id: string) {
    setConversations((current) => {
      const next = current.filter((item) => item.id !== id);
      if (next.length === 0) {
        const created = createConversation(mode, model);
        setActiveId(created.id);
        return [created];
      }
      if (activeId === id) setActiveId(next[0].id);
      return next;
    });
  }

  function clearHistory() {
    if (!window.confirm('确认清空全部会话历史？')) return;
    const created = createConversation(mode, model);
    setConversations([created]);
    setActiveId(created.id);
  }

  function stopGeneration() {
    abortRef.current?.abort();
    abortRef.current = null;
    setSending(false);
  }

  async function handleCopy(text?: string) {
    const value = String(text || '').trim();
    if (!value) return;
    await copyText(value);
    showToast('已复制');
  }

  function onComposerKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (mode === 'video' && mentionOpen && filteredMentionCandidates.length) {
      if (event.key === 'ArrowDown') {
        event.preventDefault();
        setMentionIndex((i) => (i + 1) % filteredMentionCandidates.length);
        return;
      }
      if (event.key === 'ArrowUp') {
        event.preventDefault();
        setMentionIndex((i) => (i - 1 + filteredMentionCandidates.length) % filteredMentionCandidates.length);
        return;
      }
      if (event.key === 'Enter' || event.key === 'Tab') {
        event.preventDefault();
        const item = filteredMentionCandidates[mentionIndex] || filteredMentionCandidates[0];
        if (item) void selectMentionCandidate(item);
        return;
      }
      if (event.key === 'Escape') {
        event.preventDefault();
        closeMentionPicker();
        return;
      }
    }

    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      if (!sending) {
        void sendMessage();
      }
    }
  }

  const historyImageCandidates = useMemo(() => {
    const items: Array<{ key: string; src: string; messageId: string; label: string }> = [];
    for (const conv of conversations) {
      for (const message of conv.messages) {
        const images = message.images || [];
        images.forEach((img, index) => {
          const src = imageSrc(img);
          if (!src) return;
          items.push({
            key: `${message.id}_${index}`,
            src,
            messageId: message.id,
            label: `${conv.title || '会话'} · 图${index + 1}`
          });
        });
      }
    }
    return items.slice(-24).reverse();
  }, [conversations]);

  const imageModels = useMemo(() => matchModels(models, 'image'), [models]);

  async function buildReferenceFromSource(
    source: Exclude<VideoReferenceSource, 'none'>,
    apiUrl: string,
    name: string,
    extra: Partial<VideoReferenceImage> = {}
  ): Promise<VideoReferenceImage> {
    let meta = { width: 0, height: 0 };
    try {
      const probeSrc = apiUrl;
      meta = await probeImageMeta(probeSrc);
    } catch {
      // optional
    }
    return {
      id: uid('ref'),
      name,
      previewUrl: apiUrl,
      apiUrl,
      source,
      width: meta.width || undefined,
      height: meta.height || undefined,
      ...extra
    };
  }

  async function addReferenceFiles(fileList: FileList | File[] | null) {
    if (!fileList) return;
    const files = Array.from(fileList).filter((file) => file.type.startsWith('image/'));
    if (!files.length) {
      setError('请选择图片文件');
      return;
    }
    if (videoRefs.length + files.length > 7) {
      setError('参考图最多 7 张');
      return;
    }
    setRefBusy(true);
    try {
      const next: VideoReferenceImage[] = [];
      for (const file of files) {
        if (file.size > 12 * 1024 * 1024) {
          throw new Error(`图片过大：${file.name}（请小于 12MB）`);
        }
        const dataUrl = await fileToDataUrl(file);
        next.push(
          await buildReferenceFromSource('upload', dataUrl, file.name, {
            bytes: file.size,
            mime: file.type || sniffImageMimeFromBase64(dataUrl)
          })
        );
      }
      setVideoRefs((prev) => [...prev, ...next].slice(0, 7));
      setVideoRefSource('upload');
      setMentionAssetMap((prev) => {
        const copy = { ...prev };
        for (const item of next) copy[item.id] = item;
        return copy;
      });
      setToast(`已添加 ${next.length} 张参考图`);
    } catch (error) {
      setError(error instanceof Error ? error.message : '添加参考图失败');
    } finally {
      setRefBusy(false);
    }
  }

  async function addReferenceFromUrl(rawUrl?: string) {
    const value = String(rawUrl || videoRefUrlInput || '').trim();
    if (!value) {
      setError('请输入图片 URL 或 data:image URL');
      return;
    }
    if (videoRefs.length >= 7) {
      setError('参考图最多 7 张');
      return;
    }
    if (!(value.startsWith('http://') || value.startsWith('https://') || value.startsWith('data:image/'))) {
      setError('仅支持 http(s) 或 data:image 参考图');
      return;
    }
    setRefBusy(true);
    try {
      const source: Exclude<VideoReferenceSource, 'none'> = value.startsWith('data:') ? 'upload' : 'url';
      const ref = await buildReferenceFromSource(source, value, value.slice(0, 48));
      setVideoRefs((prev) => [...prev, ref].slice(0, 7));
      setVideoRefUrlInput('');
      setVideoRefSource(source);
      setToast('参考图已添加');
    } catch (error) {
      setError(error instanceof Error ? error.message : '添加参考图失败');
    } finally {
      setRefBusy(false);
    }
  }

  async function addReferenceFromHistory(src: string, messageId: string, label: string) {
    if (!src) return;
    if (videoRefs.some((item) => item.apiUrl === src || item.previewUrl === src)) {
      setToast('该参考图已添加');
      return;
    }
    if (videoRefs.length >= 7) {
      setError('参考图最多 7 张');
      return;
    }
    setRefBusy(true);
    try {
      const ref = await buildReferenceFromSource('history', src, label, { fromMessageId: messageId });
      setVideoRefs((prev) => [...prev, ref].slice(0, 7));
      setMode('video');
      setVideoRefSource('history');
      setToast('已从历史消息加入参考图');
    } catch (error) {
      setError(error instanceof Error ? error.message : '添加参考图失败');
    } finally {
      setRefBusy(false);
    }
  }

  function removeReference(id: string) {
    setVideoRefs((prev) => prev.filter((item) => item.id !== id));
  }

  function moveReference(id: string, direction: -1 | 1) {
    setVideoRefs((prev) => {
      const index = prev.findIndex((item) => item.id === id);
      if (index < 0) return prev;
      const target = index + direction;
      if (target < 0 || target >= prev.length) return prev;
      const next = [...prev];
      const [item] = next.splice(index, 1);
      next.splice(target, 0, item);
      return next;
    });
  }

  function clearReferences() {
    setVideoRefs([]);
    setVideoRefSource('none');
    setRefStackExpanded(false);
  }



  const MENTION_TOKEN_RE = /@\[(.+?)\]\((?:id:)?([^)\s]+)\)/g;

  type MentionCandidate = {
    key: string;
    id: string;
    name: string;
    src: string;
    kind: 'upload' | 'history';
    messageId?: string;
    ref?: VideoReferenceImage;
  };

  const mentionCandidates = useMemo<MentionCandidate[]>(() => {
    const items: MentionCandidate[] = [];
    videoRefs.forEach((item, index) => {
      const name = (item.name || `图片${index + 1}`).replace(/[\[\]]/g, '').slice(0, 40);
      items.push({
        key: `ref_${item.id}`,
        id: item.id,
        name: name || `图片${index + 1}`,
        src: item.previewUrl || item.apiUrl,
        kind: 'upload',
        ref: item
      });
    });
    historyImageCandidates.forEach((item, index) => {
      // skip if already in upload refs by url
      if (videoRefs.some((ref) => ref.apiUrl === item.src || ref.previewUrl === item.src)) return;
      const name = (item.label || `素材${index + 1}`).replace(/[\[\]]/g, '').slice(0, 40);
      items.push({
        key: `hist_${item.key}`,
        id: `hist:${item.key}`,
        name,
        src: item.src,
        kind: 'history',
        messageId: item.messageId
      });
    });
    return items;
  }, [videoRefs, historyImageCandidates]);

  const filteredMentionCandidates = useMemo(() => {
    const q = mentionQuery.trim().toLowerCase();
    if (!q) return mentionCandidates.slice(0, 20);
    return mentionCandidates
      .filter((item) => item.name.toLowerCase().includes(q) || item.id.toLowerCase().includes(q))
      .slice(0, 20);
  }, [mentionCandidates, mentionQuery]);

  function extractMentionTokens(prompt: string) {
    const textValue = String(prompt || '');
    const tokens: Array<{ raw: string; name: string; id: string; index: number }> = [];
    const re = /@\[(.+?)\]\((?:id:)?([^)\s]+)\)/g;
    let match: RegExpExecArray | null;
    while ((match = re.exec(textValue)) !== null) {
      tokens.push({
        raw: match[0],
        name: String(match[1] || '').trim(),
        id: String(match[2] || '').trim(),
        index: match.index
      });
    }
    return tokens;
  }

  function cleanPromptMentions(prompt: string) {
    const original = String(prompt || '');
    const cleaned = original
      // Convert structured tokens to readable labels, keep surrounding user text intact.
      .replace(/@\[(.+?)\]\((?:id:)?([^)\s]+)\)/g, (_, name: string) => {
        const label = String(name || '').trim() || '参考图';
        return `【参考图:${label}】`;
      })
      .replace(/@((?:图片|素材|image|ref|img))\s*([0-9]{1,2})/gi, (_m, kind: string, num: string) => {
        return /素材|material/i.test(String(kind)) ? `【参考素材${num}】` : `【参考图${num}】`;
      })
      .replace(/[ \t]{2,}/g, ' ')
      .replace(/\n{3,}/g, '\n\n')
      .trim();
    // Never drop the user's prompt. If cleaning somehow empties it, fall back.
    return cleaned || original.trim();
  }

  function resolveVideoPromptAndRefs(prompt: string, refs: VideoReferenceImage[]) {
    const tokens = extractMentionTokens(prompt);
    const cleanedPrompt = cleanPromptMentions(prompt) || prompt.trim();
    const selected: VideoReferenceImage[] = [];
    const missing: string[] = [];
    const refById = new Map(refs.map((item) => [item.id, item]));
    const refByUrl = new Map(
      refs
        .flatMap((item) => [
          [String(item.apiUrl || '').trim(), item],
          [String(item.previewUrl || '').trim(), item]
        ])
        .filter(([key]) => Boolean(key)) as Array<[string, VideoReferenceImage]>
    );

    const pushRef = (item?: VideoReferenceImage | null) => {
      if (!item) return false;
      const url = String(item.apiUrl || item.previewUrl || '').trim();
      if (!url) return false;
      if (selected.some((x) => String(x.apiUrl || x.previewUrl || '').trim() === url || x.id === item.id)) {
        return true;
      }
      selected.push({
        ...item,
        apiUrl: item.apiUrl || item.previewUrl,
        previewUrl: item.previewUrl || item.apiUrl
      });
      return true;
    };

    if (tokens.length) {
      for (const token of tokens) {
        let found: VideoReferenceImage | undefined =
          mentionAssetMap[token.id] ||
          refById.get(token.id) ||
          undefined;

        if (!found && token.id.startsWith('hist:')) {
          const histKey = token.id.slice(5);
          const hist = historyImageCandidates.find((item) => item.key === histKey);
          if (hist?.src) {
            found = {
              id: token.id,
              name: token.name || hist.label,
              previewUrl: hist.src,
              apiUrl: hist.src,
              source: 'history',
              fromMessageId: hist.messageId
            };
          }
        }

        if (!found) {
          found = refs.find((item) => (item.name || '') === token.name);
        }

        // last resort: map token name against mentionAssetMap values
        if (!found) {
          found = Object.values(mentionAssetMap).find((item) => item.name === token.name || item.id === token.id);
        }

        if (!pushRef(found)) {
          missing.push(token.name || token.id);
        }
      }
    } else {
      // legacy @图片N / @素材N
      const legacyImage = Array.from(String(prompt).matchAll(/@((?:图片|image|ref|img))\s*([0-9]{1,2})/gi)).map((m) => Number(m[2]));
      const legacyMaterial = Array.from(String(prompt).matchAll(/@((?:素材|material))\s*([0-9]{1,2})/gi)).map((m) => Number(m[2]));
      for (const index of legacyImage) {
        if (!pushRef(refs[index - 1])) missing.push(`图片${index}`);
      }
      for (const index of legacyMaterial) {
        const hist = historyImageCandidates[index - 1];
        if (hist?.src) {
          pushRef({
            id: `hist:${hist.key}`,
            name: hist.label || `素材${index}`,
            previewUrl: hist.src,
            apiUrl: hist.src,
            source: 'history',
            fromMessageId: hist.messageId
          });
        } else {
          missing.push(`素材${index}`);
        }
      }
    }

    const hasMentions =
      tokens.length > 0 || /@((?:图片|素材|image|ref|img))\s*[0-9]{1,2}/i.test(prompt) || /@\[(.+?)\]\((?:id:)?([^)\s]+)\)/.test(prompt);

    // Mention mode: only selected tokens.
    // No mention: always send ALL current uploaded/reference images.
    let finalRefs = hasMentions ? selected : refs.slice(0, 7);

    // Safety net: if mentions failed to resolve but refs exist, still attach current refs
    // so图生视频不会静默退化成纯文生视频。
    if (!finalRefs.length && refs.length) {
      finalRefs = refs.slice(0, 7);
    }

    const seen = new Set<string>();
    finalRefs = finalRefs
      .filter((item) => {
        const key = String(item.apiUrl || item.previewUrl || '').trim();
        if (!key || seen.has(key)) return false;
        seen.add(key);
        return true;
      })
      .slice(0, 7);

    return {
      prompt: cleanedPrompt,
      refs: finalRefs,
      hasMentions,
      missing: hasMentions ? missing : [],
      tokens
    };
  }

  function renderComposerHighlight(text: string) {
    if (!text) return '\u00A0';
    const parts: Array<{ type: 'text' | 'mention'; value: string }> = [];
    const re = /@\[(.+?)\]\((?:id:)?([^)\s]+)\)/g;
    let last = 0;
    let match: RegExpExecArray | null;
    while ((match = re.exec(text)) !== null) {
      if (match.index > last) {
        parts.push({ type: 'text', value: text.slice(last, match.index) });
      }
      parts.push({ type: 'mention', value: match[0] });
      last = match.index + match[0].length;
    }
    if (last < text.length) parts.push({ type: 'text', value: text.slice(last) });
    if (!parts.length) parts.push({ type: 'text', value: text });
    return parts.map((part, index) => {
      if (part.type === 'mention') {
        const m = part.value.match(/^@\[(.+?)\]\((?:id:)?([^)\s]+)\)$/);
        const label = m?.[1] || part.value;
        return (
          <span className="composer-mention-chip" key={`m_${index}`}>
            @{label}
          </span>
        );
      }
      return <span key={`t_${index}`}>{part.value}</span>;
    });
  }

  function closeMentionPicker() {
    setMentionOpen(false);
    setMentionQuery('');
    setMentionStart(-1);
    setMentionIndex(0);
  }

  function updateMentionStateFromComposer(next: string, cursor: number) {
    if (mode !== 'video') {
      closeMentionPicker();
      return;
    }
    const before = next.slice(0, Math.max(0, cursor));
    const at = before.lastIndexOf('@');
    if (at < 0) {
      closeMentionPicker();
      return;
    }
    // If this @ is already part of a completed token, don't reopen.
    const maybeToken = next.slice(at);
    if (/^@\[(.+?)\]\((?:id:)?([^)\s]+)\)/.test(maybeToken)) {
      closeMentionPicker();
      return;
    }
    const between = before.slice(at + 1);
    // stop if whitespace/newline before finishing mention
    if (/[\s\n]/.test(between)) {
      closeMentionPicker();
      return;
    }
    // don't trigger inside normal email-like tokens without start boundary
    if (at > 0 && /[A-Za-z0-9_]/.test(before[at - 1] || '')) {
      closeMentionPicker();
      return;
    }
    setMentionOpen(true);
    setMentionStart(at);
    setMentionQuery(between);
    setMentionIndex(0);
  }

  function insertComposerText(snippet: string) {
    const el = composerTextareaRef.current;
    const current = composer;
    if (!el) {
      const needsSpace = current && !/\s$/.test(current);
      setComposer(`${current}${needsSpace ? ' ' : ''}${snippet}`);
      return;
    }
    const start = el.selectionStart ?? current.length;
    const end = el.selectionEnd ?? current.length;
    const before = current.slice(0, start);
    const after = current.slice(end);
    const needsSpace = before.length > 0 && !/\s$/.test(before);
    const next = `${before}${needsSpace ? ' ' : ''}${snippet}${after}`;
    setComposer(next);
    requestAnimationFrame(() => {
      const pos = start + (needsSpace ? 1 : 0) + snippet.length;
      el.focus();
      el.setSelectionRange(pos, pos);
      updateMentionStateFromComposer(next, pos);
    });
  }

  function buildMentionToken(name: string, id: string) {
    const safeName = String(name || '图片').replace(/[\[\]]/g, '').trim() || '图片';
    // group token + trailing space
    return `@[${safeName}](id:${id}) `;
  }

  async function selectMentionCandidate(item: MentionCandidate) {
    let refId = item.id;
    let displayName = item.name;

    // History image: auto-add into upload reference list so API can use it.
    if (item.kind === 'history') {
      const exists = videoRefs.find((ref) => ref.apiUrl === item.src || ref.previewUrl === item.src);
      if (exists) {
        refId = exists.id;
        displayName = exists.name || displayName;
      } else {
        try {
          setRefBusy(true);
          const ref = await buildReferenceFromSource('history', item.src, item.name, {
            fromMessageId: item.messageId
          });
          setVideoRefs((prev) => [...prev, ref].slice(0, 7));
          setVideoRefSource('history');
          refId = ref.id;
          displayName = ref.name || displayName;
          setMentionAssetMap((prev) => ({ ...prev, [ref.id]: ref }));
        } catch (error) {
          setError(error instanceof Error ? error.message : '添加参考图失败');
          return;
        } finally {
          setRefBusy(false);
        }
      }
    }

    const asset: VideoReferenceImage =
      item.kind === 'upload' && item.ref
        ? item.ref
        : {
            id: refId,
            name: displayName,
            previewUrl: item.src,
            apiUrl: item.src,
            source: item.kind === 'history' ? 'history' : 'upload',
            fromMessageId: item.messageId
          };
    // Prefer the latest concrete ref object when available from videoRefs.
    const concrete = videoRefs.find((ref) => ref.id === refId) || asset;
    setMentionAssetMap((prev) => ({
      ...prev,
      [refId]: {
        ...concrete,
        id: refId,
        name: displayName,
        apiUrl: concrete.apiUrl || concrete.previewUrl || item.src,
        previewUrl: concrete.previewUrl || concrete.apiUrl || item.src
      }
    }));

    const token = buildMentionToken(displayName, refId);
    const el = composerTextareaRef.current;
    const current = composer;
    const cursor = el?.selectionStart ?? current.length;
    const start = mentionStart >= 0 ? mentionStart : current.lastIndexOf('@', Math.max(0, cursor - 1));
    const from = start >= 0 ? start : cursor;
    const before = current.slice(0, from);
    const after = current.slice(cursor);
    const next = `${before}${token}${after}`;
    setComposer(next);
    closeMentionPicker();
    setAssetPickerOpen(false);
    setToast(`已插入 @${displayName}`);
    requestAnimationFrame(() => {
      if (!composerTextareaRef.current) return;
      const pos = before.length + token.length;
      composerTextareaRef.current.focus();
      composerTextareaRef.current.setSelectionRange(pos, pos);
    });
  }

  function insertAssetMention(label: string) {
    // fallback plain insert
    insertComposerText(`@${label} `);
    setAssetPickerOpen(false);
    setToast(`已插入 @${label}`);
  }

  async function sendMessage() {
    const content = composer.trim();
    if (!content || sending) return;
    if (!canRequest) {
      setError('请先配置 API Key。');
      setSettingsOpen(true);
      return;
    }

    // Hard guard: never send a model that does not belong to current mode when we already know the list.
    let requestModel = model.trim();
    if (models.length > 0) {
      const matched = matchModels(models, mode);
      if (matched.length > 0 && !matched.some((item) => item.id === requestModel)) {
        requestModel = pickModel(models, requestModel, mode);
        setModel(requestModel);
      }
      if (!models.some((item) => item.id === requestModel)) {
        setError(`模型不存在：${requestModel}。请先点击“同步模型”，并选择当前模式下可用的模型。`);
        return;
      }
      if (matched.length > 0 && classifyModel(requestModel) !== mode) {
        setError(`当前模式需要 ${modeMeta[mode].label} 模型，但选择了 ${requestModel}。已阻止错误请求。`);
        return;
      }
    } else if (!requestModel) {
      requestModel = modeMeta[mode].preferred;
      setModel(requestModel);
    }

    const conversation = ensureConversation();
    const conversationId = conversation.id;
    const activeRefs = mode === 'video' ? videoRefs.slice(0, 7) : [];
    const userMessage: StudioMessage = {
      id: uid('msg'),
      role: 'user',
      mode,
      content,
      status: 'done',
      createdAt: Date.now(),
      referenceImages: activeRefs.length ? activeRefs : undefined,
      images: activeRefs.length
        ? activeRefs.map((item) =>
            item.apiUrl.startsWith('data:')
              ? { b64_json: item.apiUrl.split(',')[1] || '', url: undefined }
              : { url: item.apiUrl }
          )
        : undefined
    };
    const assistantId = uid('msg');
    const assistantMessage: StudioMessage = {
      id: assistantId,
      role: 'assistant',
      mode,
      content: '',
      status: mode === 'chat' ? 'streaming' : 'pending',
      createdAt: Date.now()
    };

    updateConversation(conversationId, (item) => ({
      ...item,
      title: item.messages.length === 0 ? titleFromContent(content) : item.title,
      mode,
      model: requestModel,
      updatedAt: Date.now(),
      messages: [...item.messages, userMessage, assistantMessage]
    }));
    setComposer('');
    setSending(true);
    setError('');

    try {
      if (mode === 'chat') {
        const history = [...conversation.messages, userMessage]
          .filter((item) => item.role === 'user' || item.role === 'assistant')
          .map((item) => ({ role: item.role as 'user' | 'assistant', content: item.content }));
        const messages = [
          ...(systemPrompt.trim() ? [{ role: 'system' as const, content: systemPrompt.trim() }] : []),
          ...history
        ];

        if (streamEnabled) {
          const controller = new AbortController();
          abortRef.current = controller;
          const result = await streamChat(config, {
            model: requestModel,
            messages,
            temperature,
            maxTokens,
            signal: controller.signal,
            onDelta: (delta) => {
              updateConversation(conversationId, (item) => ({
                ...item,
                updatedAt: Date.now(),
                messages: item.messages.map((message) =>
                  message.id === assistantId
                    ? { ...message, content: `${message.content}${delta}`, status: 'streaming' }
                    : message
                )
              }));
            }
          });
          updateConversation(conversationId, (item) => ({
            ...item,
            updatedAt: Date.now(),
            messages: item.messages.map((message) =>
              message.id === assistantId
                ? { ...message, content: result.content || message.content, status: 'done', raw: result.raw }
                : message
            )
          }));
        } else {
          const result = await generateChat(config, { model: requestModel, messages, temperature, maxTokens });
          updateConversation(conversationId, (item) => ({
            ...item,
            updatedAt: Date.now(),
            messages: item.messages.map((message) =>
              message.id === assistantId
                ? { ...message, content: result.content, status: 'done', raw: result.raw }
                : message
            )
          }));
        }
      } else if (mode === 'image') {
        const result = await generateImage(config, {
          model: requestModel,
          prompt: content,
          n: imageCount,
          size: imageSize
        });
        updateConversation(conversationId, (item) => ({
          ...item,
          updatedAt: Date.now(),
          messages: item.messages.map((message) =>
            message.id === assistantId
              ? {
                  ...message,
                  content: `已生成 ${result.data.length} 张图片`,
                  status: 'done',
                  images: result.data,
                  raw: result.raw
                }
              : message
          )
        }));
      } else {
        // Prefer live composer refs; fall back to the just-created user message refs.
        // Resolve prompt mentions (@图片N / @素材N) into concrete reference images.
        
        const promptResolution = resolveVideoPromptAndRefs(content, activeRefs);
        let videoPrompt = promptResolution.prompt;
        let resolvedRefs = promptResolution.refs.slice();

        // Absolute fallback: if prompt mentions exist but resolve empty, keep activeRefs.
        if (!resolvedRefs.length && activeRefs.length) {
          resolvedRefs = activeRefs.slice(0, 7);
        }

        if (promptResolution.hasMentions && promptResolution.missing.length && !resolvedRefs.length) {
          throw new Error(
            `提示词中的 @ 占位图无法解析：${promptResolution.missing.map((n) => '@' + n).join('、')}。请重新用 @ 选择图片。`
          );
        }

        let referenceUrls = resolvedRefs
          .map((item) => String(item.apiUrl || item.previewUrl || '').trim())
          .filter((url) => Boolean(url) && (url.startsWith('data:') || /^https?:\/\//i.test(url) || url.startsWith('blob:')));

        // blob: cannot be sent to remote API; convert is not available here, so drop and warn.
        const blockedBlob = resolvedRefs.filter((item) => String(item.apiUrl || '').startsWith('blob:'));
        referenceUrls = referenceUrls.filter((url) => !url.startsWith('blob:'));
        if (!referenceUrls.length && blockedBlob.length) {
          throw new Error('参考图是本地 blob 地址，无法直接传给 CPA。请重新上传图片或使用 data/http 图片。');
        }

        if (!referenceUrls.length && userMessage.referenceImages?.length) {
          referenceUrls = userMessage.referenceImages
            .map((item: any) => String(item?.apiUrl || item?.previewUrl || item?.url || '').trim())
            .filter((url) => url && !url.startsWith('blob:') && (url.startsWith('data:') || /^https?:\/\//i.test(url)));
        }

        // Final unique list
        referenceUrls = Array.from(new Set(referenceUrls)).slice(0, 7);

        if (promptResolution.hasMentions && !referenceUrls.length) {
          throw new Error('提示词包含 @ 参考图，但没有解析到可发送的图片地址。请重新用 @ 选择图片。');
        }

        if (referenceUrls.length) {
          setToast(`将附带 ${referenceUrls.length} 张参考图生成视频`);
        }

        let pipelineNote = referenceUrls.length
          ? `已附带 ${referenceUrls.length} 张参考图。`
          : '';

        let pipeline: 'text-to-video' | 'image-to-video' | 'image-then-video' = referenceUrls.length
          ? 'image-to-video'
          : 'text-to-video';

        if (videoPipelineEnabled && !referenceUrls.length) {
          pipeline = 'image-then-video';
          const imageModel =
            (imageModels.some((item) => item.id === pipelineImageModel) && pipelineImageModel) ||
            pickModel(models, pipelineImageModel || modeMeta.image.preferred, 'image');
          updateConversation(conversationId, (item) => ({
            ...item,
            updatedAt: Date.now(),
            messages: item.messages.map((message) =>
              message.id === assistantId
                ? {
                    ...message,
                    content: `流水线第 1 步：使用 ${imageModel} 生成参考图...`,
                    status: 'pending'
                  }
                : message
            )
          }));

          const imageResult = await generateImage(config, {
            model: imageModel,
            prompt: videoPrompt,
            n: 1,
            size: pipelineImageSize,
            responseFormat: 'b64_json'
          });
const first = imageResult.data?.[0];
          const src = imageSrc(first || {});
          if (!src) {
            throw new Error('流水线生图失败：未返回可用图片');
          }
          referenceUrls = [src];
          pipelineNote = '已先生成参考图，再转入视频生成。';
          setVideoRefs([
            await buildReferenceFromSource('pipeline', src, 'pipeline-source', {
              mime: first?.b64_json ? sniffImageMimeFromBase64(first.b64_json) : undefined
            })
          ]);
          setVideoRefSource('pipeline');

          updateConversation(conversationId, (item) => ({
            ...item,
            updatedAt: Date.now(),
            messages: item.messages.map((message) =>
              message.id === assistantId
                ? {
                    ...message,
                    content: `流水线第 1 步完成，开始生成视频...`,
                    status: 'pending',
                    images: imageResult.data,
                    raw: imageResult.raw
                  }
                : message
            )
          }));
        }

        if (requestModel.toLowerCase().includes('1.5-preview') && !referenceUrls.length) {
          throw new Error('grok-imagine-video-1.5-preview 需要参考图；请上传/选择图片，或在提示词使用 @图片1，或开启“先出图再生视频”。');
        }
        if (promptResolution.hasMentions && !referenceUrls.length) {
          throw new Error('提示词包含 @图片/@素材，但没有解析到可用参考图。请检查编号是否对应已添加的参考图/素材。');
        }
        if (!referenceUrls.length && /@图片|@素材/.test(content)) {
          throw new Error('检测到 @素材/@图片，但当前没有可用参考图。请先在左侧参考图区上传，或从 @ 面板选择历史图片加入参考图。');
        }

        updateConversation(conversationId, (item) => ({
          ...item,
          updatedAt: Date.now(),
          messages: item.messages.map((message) =>
            message.id === assistantId
              ? {
                  ...message,
                  content:
                    pipeline === 'image-then-video'
                      ? '流水线第 2 步：提交图生视频任务...'
                      : referenceUrls.length
                        ? `提交图生视频任务（${referenceUrls.length} 张参考图${promptResolution.hasMentions ? '，已按提示词引用' : ''}）...`
                        : '提交文生视频任务...',
                  status: 'pending'
                }
              : message
          )
        }));

        // Final prompt sent to API: always based on the original composer text.
        const apiPrompt = (videoPrompt || cleanPromptMentions(content) || content).trim();
        if (!apiPrompt) {
          throw new Error('提示词为空，无法创建视频任务');
        }
        if (!referenceUrls.length && activeRefs.length) {
          // hard fallback right before request
          referenceUrls = activeRefs
            .map((item) => String(item.apiUrl || item.previewUrl || '').trim())
            .filter((url) => url && (url.startsWith('data:') || /^https?:\/\//i.test(url)))
            .slice(0, 7);
        }

        updateConversation(conversationId, (item) => ({
          ...item,
          updatedAt: Date.now(),
          messages: item.messages.map((message) =>
            message.id === assistantId
              ? {
                  ...message,
                  content:
                    `准备提交：提示词「${apiPrompt.slice(0, 80)}${apiPrompt.length > 80 ? '…' : ''}」` +
                    (referenceUrls.length ? `；参考图 ${referenceUrls.length} 张` : '；无参考图（文生视频）'),
                  status: 'pending'
                }
              : message
          )
        }));
        setToast(
          referenceUrls.length
            ? `发送中：提示词已带上，参考图 ${referenceUrls.length} 张`
            : '发送中：提示词已带上（文生视频）'
        );

        const result = await generateVideo(config, {
          model: requestModel,
          prompt: apiPrompt,
          seconds: videoDuration,
          duration: videoDuration,
          aspectRatio: videoAspectRatio,
          resolution: videoResolution,
          imageUrl: referenceUrls[0],
          referenceImageUrls: referenceUrls,
          useInputReference: videoUseInputReference
        });
        const requestId = String(result.request_id || result.id || '').trim();
        if (!requestId) {
          throw new Error('上游未返回新的 request_id，已中止，避免误用旧视频');
        }
        // Drop any previous blob cache confusion for this brand-new task id.
        if (videoObjectUrlsRef.current[requestId]) {
          const old = videoObjectUrlsRef.current[requestId];
          if (old.startsWith('blob:')) {
            try { URL.revokeObjectURL(old); } catch {}
          }
          const next = { ...videoObjectUrlsRef.current };
          delete next[requestId];
          videoObjectUrlsRef.current = next;
          setVideoObjectUrls((prev) => {
            const copy = { ...prev };
            delete copy[requestId];
            return copy;
          });
        }
        updateConversation(conversationId, (item) => ({
          ...item,
          updatedAt: Date.now(),
          messages: item.messages.map((message) =>
            message.id === assistantId
              ? {
                  ...message,
                  content:
                    `${pipelineNote ? pipelineNote + ' ' : ''}新视频任务已提交：${requestId}\n提示词：${apiPrompt}\n参考图：${referenceUrls.length} 张\n请等待该任务完成，不会复用旧视频`,
                  status: 'pending',
                  error: undefined,
                  video: {
                    id: requestId,
                    status: 'submitted',
                    url: undefined,
                    duration: videoDuration,
                    aspectRatio: videoAspectRatio,
                    resolution: videoResolution,
                    sourceImageCount: referenceUrls.length,
                    pipeline
                  },
                  }
              : message
          )
        }));
        if (requestId) {
          activeVideoRequestIdRef.current = requestId;
          // Do not block the send flow / UI on long polling.
          void pollVideoIntoMessage(conversationId, assistantId, requestId);
        } else {
          throw new Error('视频任务已提交，但上游未返回 request id');
        }
      }
    } catch (requestError) {
      const messageText = requestError instanceof Error ? requestError.message : '生成失败';
      if (messageText.toLowerCase().includes('abort')) {
        updateConversation(conversationId, (item) => ({
          ...item,
          messages: item.messages.map((message) =>
            message.id === assistantId
              ? { ...message, status: message.content ? 'done' : 'error', error: '已停止生成' }
              : message
          )
        }));
      } else {
        setError(messageText);
        updateConversation(conversationId, (item) => ({
          ...item,
          messages: item.messages.map((message) =>
            message.id === assistantId
              ? { ...message, status: 'error', error: messageText, content: message.content || '生成失败' }
              : message
          )
        }));
      }
    } finally {
      abortRef.current = null;
      setSending(false);
    }
  }

  async function pollVideoIntoMessage(conversationId: string, messageId: string, requestId: string) {
    const targetId = String(requestId || '').trim();
    if (!targetId) return;

    // Give CPA a moment to register the task before first status hit.
    await new Promise((resolve) => window.setTimeout(resolve, 1500));

    for (let attempt = 0; attempt < 60; attempt += 1) {
      try {
        if (activeVideoRequestIdRef.current && activeVideoRequestIdRef.current !== targetId) {
          // A newer video task was started; stop polling the old one.
          return;
        }
        const status = await fetchVideoStatus(config, targetId);
        const normalized = String(status.status || '').toLowerCase();
        const progress =
          typeof status.progress === 'number' && Number.isFinite(status.progress)
            ? Math.max(0, Math.min(100, status.progress))
            : undefined;
        const progressText = typeof progress === 'number' ? ` · 进度 ${progress}%` : '';

        // Strict completion: never treat "has url" alone as done while still pending/processing.
        const isFailed = ['failed', 'error', 'canceled', 'cancelled', 'expired'].includes(normalized);
        const isDone =
          !isFailed &&
          (
            normalized === 'done' ||
            normalized === 'completed' ||
            normalized === 'succeeded' ||
            normalized === 'success' ||
            normalized === 'complete' ||
            (Boolean(status.url) && !['pending', 'queued', 'in_progress', 'processing', 'running', 'submitted', ''].includes(normalized) && progress === 100) ||
            (Boolean(status.url) && normalized === '' && progress === 100)
          );

        // Always bind this message to the polled request id, not some other id from payload.
        const boundVideoId = targetId;
        // Reject foreign urls that clearly belong to another task.
        const rawUrl = String(status.url || '').trim();
        const urlBelongs =
          !rawUrl ||
          rawUrl.includes(boundVideoId) ||
          !/xai-video-[a-f0-9-]+/i.test(rawUrl);
        const nextUrl = isDone && urlBelongs ? (rawUrl || undefined) : undefined;
        if (isDone && rawUrl && !urlBelongs) {
          console.warn('Ignored foreign video url for task', boundVideoId, rawUrl);
        }

        updateConversation(conversationId, (item) => ({
          ...item,
          updatedAt: Date.now(),
          messages: item.messages.map((message) =>
            message.id === messageId
              ? {
                  ...message,
                  content: isDone
                    ? `视频已生成完成（${boundVideoId}）`
                    : isFailed
                      ? `视频生成失败${status.error ? `：${status.error}` : ''}`
                      : `等待生成中：${status.status || 'pending'}${progressText}（第 ${attempt + 1} 次）`,
                  status: isDone ? 'done' : isFailed ? 'error' : 'pending',
                  error: isFailed ? status.error || `视频失败：${status.status || 'failed'}` : undefined,
                  video: {
                    id: boundVideoId,
                    status: isDone ? 'done' : status.status || 'pending',
                    // Do not attach playable url until generation is actually done.
                    url: nextUrl,
                    progress,
                    duration: status.duration
                  }
                }
              : message
          )
        }));

        if (isDone) {
          try {
            // Only hydrate THIS finished video id.
            if (activeVideoRequestIdRef.current === boundVideoId || !activeVideoRequestIdRef.current) {
              await ensureCpaVideoObjectUrl(boundVideoId, nextUrl, true, true);
            }
          } catch (hydrateError) {
            console.warn('CPA video hydrate failed', hydrateError);
          }
          return;
        }
        if (isFailed) return;
      } catch (requestError) {
        // Transient status failures should not kill the whole wait loop immediately.
        const messageText = requestError instanceof Error ? requestError.message : '视频状态查询失败';
        const transient = /503|502|504|timeout|network|fetch|暂时|unavailable/i.test(messageText);
        updateConversation(conversationId, (item) => ({
          ...item,
          updatedAt: Date.now(),
          messages: item.messages.map((message) =>
            message.id === messageId
              ? {
                  ...message,
                  content: transient
                    ? `状态查询暂时失败，继续等待（第 ${attempt + 1} 次）：${messageText}`
                    : message.content,
                  status: transient ? 'pending' : 'error',
                  error: transient ? undefined : messageText,
                  video: {
                    id: targetId,
                    status: transient ? 'pending' : 'failed'
                  }
                }
              : message
          )
        }));
        if (!transient) return;
      }
      await new Promise((resolve) => window.setTimeout(resolve, 4000));
    }

    updateConversation(conversationId, (item) => ({
      ...item,
      updatedAt: Date.now(),
      messages: item.messages.map((message) =>
        message.id === messageId
          ? {
              ...message,
              status: 'error',
              error: '视频生成超时：仍未完成，请稍后用任务 ID 重试预览',
              content: `视频生成超时（${targetId}）`,
              video: {
                id: targetId,
                status: 'timeout'
              }
            }
          : message
      )
    }));
  }

  async function ensureCpaVideoObjectUrl(
    videoId?: string,
    remoteUrl?: string,
    allowRemoteFallback = true,
    force = false
  ) {
    const id = String(videoId || '').trim();
    const remote = String(remoteUrl || '').trim();
    if (!id && !remote) return '';

    if (!force) {
      if (id) {
        const cached = videoObjectUrlsRef.current[id] || videoObjectUrls[id];
        if (cached) return cached;
      } else if (remote) {
        const cached = videoObjectUrlsRef.current[remote] || videoObjectUrls[remote];
        if (cached) return cached;
      }
    } else if (id) {
      const old = videoObjectUrlsRef.current[id] || videoObjectUrls[id];
      if (old && old.startsWith('blob:')) {
        try { URL.revokeObjectURL(old); } catch {}
      }
    }

    let objectUrl = '';
    let lastError: Error | null = null;

    if (id) {
      try {
        objectUrl = await fetchVideoObjectUrl(config, id);
      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error));
      }
    }

    // Remote fallback only if URL clearly belongs to this task id when id is present.
    const remoteLooksLikeThisTask =
      !id ||
      !remote ||
      remote.includes(id) ||
      /xai-video-/i.test(remote) && remote.toLowerCase().includes(id.toLowerCase());

    if (!objectUrl && allowRemoteFallback && remote && remoteLooksLikeThisTask) {
      try {
        objectUrl = await fetchRemoteVideoObjectUrl(remote);
      } catch (error) {
        const proxied = resolvePlayableVideoUrl(remote, undefined, true);
        if (proxied) objectUrl = proxied;
        else lastError = error instanceof Error ? error : new Error(String(error));
      }
    }

    if (!objectUrl) {
      throw lastError || new Error('无法获取可播放视频');
    }

    if (id) {
      videoObjectUrlsRef.current = { ...videoObjectUrlsRef.current, [id]: objectUrl };
      setVideoObjectUrls((prev) => ({ ...prev, [id]: objectUrl }));
    } else if (remote) {
      videoObjectUrlsRef.current = { ...videoObjectUrlsRef.current, [remote]: objectUrl };
      setVideoObjectUrls((prev) => ({ ...prev, [remote]: objectUrl }));
    }
    return objectUrl;
  }

  // NOTE: do NOT auto-hydrate historical videos.
  // Old auto-fetch caused the UI to keep pulling existing videos instead of waiting for the new task.
  // Playback is hydrated only when:
  // 1) the current poll finishes a NEW request id, or
  // 2) user clicks "重试预览".

  useEffect(() => {
    return () => {
      Object.values(videoObjectUrlsRef.current).forEach((url) => {
        try { URL.revokeObjectURL(url); } catch {}
      });
    };
  }, []);

  async function handleDownloadVideo(url?: string, id?: string) {
    const videoId = String(id || '').trim();
    const key = videoId || String(url || '').trim();
    if (!key) return;
    setDownloadingVideoId(key);
    try {
      if (videoId) {
        await downloadVideoContent(config, videoId, `${videoId}.mp4`);
        setToast('已通过 CPA 下载视频');
        return;
      }
      if (url) {
        const response = await fetch(url);
        if (!response.ok) throw new Error('下载失败');
        const blob = await response.blob();
        const objectUrl = URL.createObjectURL(blob);
        const anchor = document.createElement('a');
        anchor.href = objectUrl;
        anchor.download = 'video.mp4';
        document.body.appendChild(anchor);
        anchor.click();
        anchor.remove();
        window.setTimeout(() => URL.revokeObjectURL(objectUrl), 1500);
        setToast('已下载视频');
        return;
      }
      throw new Error('缺少视频任务 ID，无法通过 CPA 下载');
    } catch (error) {
      setError(error instanceof Error ? error.message : '下载失败');
    } finally {
      setDownloadingVideoId('');
    }
  }

  const connectionLabel = !hasApiKey
    ? '待配置'
    : config.connectionMode === 'direct'
      ? '直连 CPA'
      : '本地反代→CPA';
  const modelSelectOptions = modeModels.length > 0 ? modeModels : model ? [{ id: model }] : [];

  return (
    <div className="studio-shell">
      <div className="studio-backdrop" />
      <div className={`studio-layout ${sidebarOpen ? '' : 'sidebar-collapsed'}`}>
        <aside className="history-panel">
          <div className="history-header">
            <div>
              <p className="eyebrow">Grok Studio</p>
              <h1>创作工作台</h1>
              <p className="subtle">对话 / 图片 / 视频一体会话流</p>
            </div>
            <div className="row-actions compact">
              <button className="ghost-btn" onClick={createNewConversation} title="新对话">
                新建
              </button>
              <button className="ghost-btn" onClick={clearHistory} title="清空历史">
                清空
              </button>
            </div>
          </div>

          <div className="history-settings">
            <button className="settings-toggle" onClick={() => setSettingsOpen((value) => !value)}>
              <span>连接设置 · {connectionLabel}</span>
              <span className="chevron">{settingsOpen ? '收起' : '展开'}</span>
            </button>
            {settingsOpen ? (
              <div className="settings-box">
                <label>
                  <span>连接模式</span>
                  <select
                    value={config.connectionMode === 'direct' ? 'direct' : 'proxy'}
                    onChange={(event) => {
                      const mode = event.target.value === 'direct' ? 'direct' : 'proxy';
                      setConfig((current) => ({
                        ...current,
                        connectionMode: mode,
                        baseUrl: mode === 'proxy' ? '' : (current.baseUrl || current.proxyTarget || DEFAULT_PROXY_TARGET),
                        proxyTarget: current.proxyTarget || DEFAULT_PROXY_TARGET
                      }));
                    }}
                  >
                    <option value="proxy">本地反代（推荐，CPA 可见调用）</option>
                    <option value="direct">浏览器直连 CPA（需 CORS）</option>
                  </select>
                </label>
                <label>
                  <span>{config.connectionMode === 'direct' ? 'CPA 地址' : 'CPA 上游（反代目标）'}</span>
                  <input
                    value={config.connectionMode === 'direct' ? config.baseUrl : (config.proxyTarget || DEFAULT_PROXY_TARGET)}
                    onChange={(event) =>
                      setConfig((current) =>
                        current.connectionMode === 'direct'
                          ? { ...current, baseUrl: event.target.value, connectionMode: 'direct' }
                          : { ...current, proxyTarget: event.target.value, connectionMode: 'proxy', baseUrl: '' }
                      )
                    }
                    placeholder="例如 http://154.201.92.160:8000（不要带 /v1）"
                  />
                </label>
                <label>
                  <span>API Key</span>
                  <input
                    value={config.apiKey}
                    onChange={(event) => setConfig((current) => ({ ...current, apiKey: event.target.value }))}
                    placeholder="Bearer g2a_... / sk-..."
                  />
                </label>
                <div className="hint-box">推荐使用本地反代：浏览器请求本机 /v1/*，由 Studio 转发到 CPA，调用会出现在 CPA 日志/管理端。直连模式若 CORS 失败，CPA 侧可能完全看不到请求。</div>
                <div className="row-actions">
                  <button
                    className="primary-btn"
                    onClick={() => void refreshModels()}
                    disabled={modelLoading || !canRequest}
                  >
                    {modelLoading ? '获取中...' : '获取模型'}
                  </button>
                  <button
                    className="ghost-btn"
                    onClick={() => {
                      setConfig(defaultConfig);
                      setModels([]);
                      setModelError('');
                      setModelNotice('');
                      autoFetchedRef.current = false;
                    }}
                  >
                    清空配置
                  </button>
                </div>
                {modelNotice ? <p className="success-text">{modelNotice}</p> : null}
                {modelError ? <p className="error-text">{modelError}</p> : null}
              </div>
            ) : null}
          </div>

          <label className="search-box">
            <span>搜索会话</span>
            <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="标题 / 模型 / 模式" />
          </label>

          <div className="history-list">
            {filteredConversations.length === 0 ? (
              <div className="empty-history">没有匹配的会话</div>
            ) : (
              filteredConversations.map((item) => (
                <button
                  key={item.id}
                  className={`history-item ${item.id === active?.id ? 'active' : ''}`}
                  onClick={() => {
                    setActiveId(item.id);
                    setMode(item.mode);
                    setModel(item.model);
                  }}
                >
                  <div className="history-item-main">
                    <strong>{item.title}</strong>
                    <span>
                      {modeMeta[item.mode].label} · {item.model}
                    </span>
                    <span className="history-time">
                      {item.messages.length ? `${item.messages.length} 条` : '空对话'} · {formatTime(item.updatedAt)}
                    </span>
                  </div>
                  <span
                    className="history-delete"
                    onClick={(event) => {
                      event.stopPropagation();
                      deleteConversation(item.id);
                    }}
                  >
                    删除
                  </span>
                </button>
              ))
            )}
          </div>
        </aside>

        <main className="chat-panel">
          <header className="chat-header">
            <div className="chat-header-copy">
              <button className="ghost-btn mobile-only" onClick={() => setSidebarOpen((value) => !value)}>
                {sidebarOpen ? '隐藏会话' : '显示会话'}
              </button>
              <div>
                <h2>{active?.title || '新对话'}</h2>
                <p>
                  {modeMeta[mode].endpoint} · {model || '未选择模型'}
                </p>
              </div>
            </div>
            <div className="chat-header-actions">
              <button className="ghost-btn" onClick={() => setSettingsOpen(true)}>
                连接
              </button>
              <button className="ghost-btn" onClick={createNewConversation}>
                新对话
              </button>
              <button
                className="ghost-btn"
                disabled={!active?.messages.length}
                onClick={() =>
                  active &&
                  updateConversation(active.id, (item) => ({
                    ...item,
                    messages: [],
                    updatedAt: Date.now(),
                    title: '新对话'
                  }))
                }
              >
                清空当前
              </button>
            </div>
          </header>

          <div className="message-list" ref={listRef}>
            {!active?.messages.length ? (
              <div className="empty-chat">
                <div className="empty-badge">独立 Studio</div>
                <h3>开始一次新的创作</h3>
                <p>
                  左侧管理会话与连接，中间查看消息流，底部统一输入。对话走 /v1/chat/completions，图片走 /v1/images/generations，视频走 /v1/videos/*。
                </p>
                <div className="quick-modes">
                  {(Object.keys(modeMeta) as StudioMode[]).map((item) => (
                    <button key={item} className={mode === item ? 'active' : ''} onClick={() => setMode(item)}>
                      {modeMeta[item].label}
                      <small>{modeMeta[item].hint}</small>
                    </button>
                  ))}
                </div>
                {!hasApiKey ? <div className="empty-tip">请先在左侧填写 API Key，再获取模型。</div> : null}
                {hasApiKey && models.length === 0 ? (
                  <div className="empty-tip">还没有模型列表，点击“获取模型”同步 /v1/models。</div>
                ) : null}
              </div>
            ) : (
              active.messages.map((message) => {
                const imageItems = (message.images || [])
                  .map((item) => ({ ...item, src: imageSrc(item) }))
                  .filter((item) => item.src);
                return (
                  <article key={message.id} className={`message-bubble ${message.role}`}>
                    <div className="message-meta">
                      <strong>{message.role === 'user' ? '你' : '助手'}</strong>
                      <span>{modeMeta[message.mode].label}</span>
                      <span className={`status-pill is-${message.status}`}>{statusLabel(message.status)}</span>
                      <span>{formatTime(message.createdAt)}</span>
                    </div>
                    {message.content ? <div className="message-content">{message.content}</div> : null}
                    {message.error ? <div className="message-error">{message.error}</div> : null}

                    {imageItems.length > 0 ? (
                      <div className="message-gallery">
                        {imageItems.map((item, index) => (
                          <div className="gallery-card" key={`${message.id}_${index}`}>
                            <button className="gallery-thumb" onClick={() => setPreviewImage(item.src)}>
                              <img src={item.src} alt={item.revised_prompt || `image-${index + 1}`} />
                            </button>
                            <div className="gallery-actions">
                              <button className="ghost-btn" onClick={() => setPreviewImage(item.src)}>
                                预览
                              </button>
                              <a className="ghost-btn" href={item.src} target="_blank" rel="noreferrer">
                                打开
                              </a>
                              <button className="ghost-btn" onClick={() => void handleCopy(item.src)}>
                                复制链接</button>
                              <button
                                className="ghost-btn"
                                onClick={() => void addReferenceFromHistory(item.src, message.id, `消息参考图 ${index + 1}`)}
                              >
                                用作视频参考图
                              </button>
                            </div>
                          </div>
                        ))}
                      </div>
                    ) : null}

                    {message.video ? (
                      <div className="message-video">
                        <div className="video-status">
                          任务 ID：{message.video.id || '未知'} · 状态：{message.video.status || 'unknown'}
                          {message.video.url
                            ? ` · 文件：${String(message.video.url).split('/').pop()}`
                            : ''}
                          {message.video.id && videoObjectUrls[message.video.id] ? ' · 已加载当前任务视频' : ''}
                        </div>
                        {(message.video.url || message.video.id) ? (
                          <>
                            <div className="video-player-wrap">
                              {(() => {
                                const videoStatus = String(message.video?.status || message.status || '').toLowerCase();
                                const finished =
                                  message.status === 'done' ||
                                  ['done', 'completed', 'succeeded', 'success', 'complete'].includes(videoStatus);
                                const taskId = String(message.video?.id || '').trim();
                                const isActiveTask = Boolean(taskId) && taskId === activeVideoRequestIdRef.current;
                                // Strict: only the blob fetched for THIS task id can autoplay.
                                // No cross-task remote fallback except explicit retry by user.
                                const playUrl = finished && taskId ? videoObjectUrls[taskId] || '' : '';

                                if (!finished) {
                                  return (
                                    <div className="video-hydrate-panel">
                                      <div className="video-status">
                                        正在等待当前任务生成完成
                                        {message.video?.id ? `（${message.video.id}）` : ''}
                                        {typeof message.video?.progress === 'number'
                                          ? ` · ${message.video.progress}%`
                                          : ''}
                                        ...
                                      </div>
                                    </div>
                                  );
                                }

                                if (playUrl) {
                                  return (
                                    <video
                                      key={`${message.video?.id || ''}_${playUrl}`}
                                      className="video-player"
                                      src={playUrl}
                                      controls
                                      playsInline
                                      preload="metadata"
                                    />
                                  );
                                }

                                return (
                                  <div className="video-hydrate-panel">
                                    <div className="video-status">生成已完成，正在获取可播放视频...</div>
                                    <button
                                      className="ghost-btn"
                                      type="button"
                                      onClick={() => {
                                        void (async () => {
                                          try {
                                            await ensureCpaVideoObjectUrl(message.video?.id, message.video?.url, true, true);
                                            setToast(`已加载任务 ${message.video?.id || ''}`);
                                          } catch (error) {
                                            setError(error instanceof Error ? error.message : '视频预览失败');
                                          }
                                        })();
                                      }}
                                    >
                                      重试预览
                                    </button>
                                  </div>
                                );
                              })()}
                            </div>
                            <div className="row-actions">
                              <button
                                className="primary-btn"
                                onClick={() => {
                                  void (async () => {
                                    try {
                                      const u = await ensureCpaVideoObjectUrl(message.video?.id, message.video?.url, true);
                                      if (u) setPreviewVideo(u);
                                    } catch (error) {
                                      setError(error instanceof Error ? error.message : 'CPA 预览失败');
                                    }
                                  })();
                                }}
                              >
                                全屏预览
                              </button>
                              <button
                                className="ghost-btn"
                                onClick={() =>
                                  void handleDownloadVideo(message.video?.url, message.video?.id)
                                }
                                disabled={downloadingVideoId === (message.video?.id || message.video?.url)}
                              >
                                {downloadingVideoId === (message.video?.id || message.video?.url)
                                  ? '下载中...'
                                  : '下载到本地'}
                              </button>
                              <button
                                className="ghost-btn"
                                type="button"
                                onClick={() => {
                                  void (async () => {
                                    try {
                                      await ensureCpaVideoObjectUrl(message.video?.id, message.video?.url, false);
                                      setToast('已通过 CPA 获取视频');
                                    } catch (error) {
                                      setError(error instanceof Error ? error.message : 'CPA 获取视频失败');
                                    }
                                  })();
                                }}
                              >
                                重新拉取(CPA)
                              </button>
                              <button
                                className="ghost-btn"
                                onClick={() => void handleCopy(message.video?.id || message.video?.url || '')}
                              >
                                复制任务ID
                              </button>
                            </div>
                          </>
                        ) : message.status === 'pending' ? (
                          <div className="pending-tip">正在轮询视频状态，请稍候... 完成后可直接预览并下载到本地。</div>
                        ) : null}
                      </div>
                    ) : null}

                    <div className="message-actions">
                      {message.content ? (
                        <button className="ghost-btn" onClick={() => void handleCopy(message.content)}>
                          复制文本
                        </button>
                      ) : null}
                      {message.role === 'user' ? (
                        <button
                          className="ghost-btn"
                          onClick={() => {
                            setComposer(message.content);
                            setMode(message.mode);
                          }}
                        >
                          填入输入框
                        </button>
                      ) : null}
                    </div>
                  </article>
                );
              })
            )}
          </div>

          <footer className="composer-panel">
            <div className="composer-toolbar">
              <div className="mode-switch">
                {(Object.keys(modeMeta) as StudioMode[]).map((item) => (
                  <button key={item} className={mode === item ? 'active' : ''} onClick={() => setMode(item)}>
                    {modeMeta[item].label}
                  </button>
                ))}
              </div>
              <div className="composer-controls">
                <select
                  value={model}
                  onChange={(event) => setModel(event.target.value)}
                  disabled={!modelSelectOptions.length}
                >
                  {modelSelectOptions.length === 0 ? <option value="">暂无模型</option> : null}
                  {modelSelectOptions.map((item) => (
                    <option key={item.id} value={item.id}>
                      {item.id}
                    </option>
                  ))}
                </select>
                <button className="ghost-btn" onClick={() => void refreshModels()} disabled={modelLoading || !canRequest}>
                  {modelLoading ? '同步中' : '同步模型'}
                </button>
              </div>
            </div>

            {usingFallbackModels ? (
              <div className="soft-banner">当前模式没有精确匹配模型，已回退显示全部模型。视频请优先选择 grok-imagine-video。</div>
            ) : null}
            {!models.length && hasApiKey ? (
              <div className="soft-banner">尚未获取到模型列表。可点击“同步模型”，或检查 Key / 代理配置。</div>
            ) : null}

            {mode === 'chat' ? (
              <div className="composer-controls chat-options">
                <input
                  className="system-input"
                  value={systemPrompt}
                  onChange={(event) => setSystemPrompt(event.target.value)}
                  placeholder="系统提示词"
                />
                <input
                  className="mini-input"
                  type="number"
                  min={0}
                  max={2}
                  step={0.1}
                  value={temperature}
                  onChange={(event) => setTemperature(Number(event.target.value))}
                  title="Temperature"
                />
                <input
                  className="mini-input"
                  type="number"
                  min={1}
                  value={maxTokens}
                  onChange={(event) => setMaxTokens(Number(event.target.value))}
                  title="Max Tokens"
                />
                <label className="inline-check">
                  <input
                    type="checkbox"
                    checked={streamEnabled}
                    onChange={(event) => setStreamEnabled(event.target.checked)}
                  />
                  流式输出
                </label>
              </div>
            ) : null}

            {mode === 'image' ? (
              <div className="composer-controls">
                <select value={imageSize} onChange={(event) => setImageSize(event.target.value)}>
                  <option value="1024x1024">1024x1024</option>
                  <option value="1024x1792">1024x1792</option>
                  <option value="1792x1024">1792x1024</option>
                  <option value="512x512">512x512</option>
                </select>
                <input
                  className="mini-input"
                  type="number"
                  min={1}
                  max={4}
                  value={imageCount}
                  onChange={(event) => setImageCount(Number(event.target.value))}
                  title="图片数量"
                />
              </div>
            ) : null}

            {mode === 'video' ? (
              <div className="video-advanced">
                <div className="composer-controls video-chip-row">
                  <select value={videoDuration} onChange={(event) => setVideoDuration(event.target.value)} title="时长">
                    <option value="4">4s</option>
                    <option value="6">6s</option>
                    <option value="8">8s</option>
                    <option value="10">10s</option>
                    <option value="12">12s</option>
                    <option value="15">15s</option>
                  </select>
                  <select value={videoAspectRatio} onChange={(event) => setVideoAspectRatio(event.target.value)} title="比例">
                    <option value="16:9">16:9</option>
                    <option value="9:16">9:16</option>
                    <option value="1:1">1:1</option>
                    <option value="4:3">4:3</option>
                    <option value="3:4">3:4</option>
                  </select>
                  <select value={videoResolution} onChange={(event) => setVideoResolution(event.target.value)} title="分辨率">
                    <option value="480p">480p</option>
                    <option value="720p">720p</option>
                    <option value="1080p">1080p</option>
                  </select>
                  <label className="inline-check" title="单图时使用 input_reference">
                    <input
                      type="checkbox"
                      checked={videoUseInputReference}
                      onChange={(event) => setVideoUseInputReference(event.target.checked)}
                    />
                    单图 input_reference
                  </label>
                  <label className="inline-check pipeline-check">
                    <input
                      type="checkbox"
                      checked={videoPipelineEnabled}
                      onChange={(event) => setVideoPipelineEnabled(event.target.checked)}
                    />
                    先出图再生视频
                  </label>
                  {videoPipelineEnabled ? (
                    <>
                      <select
                        value={pipelineImageModel}
                        onChange={(event) => setPipelineImageModel(event.target.value)}
                        title="出图模型"
                      >
                        {(imageModels.length ? imageModels : [{ id: 'grok-imagine-image' } as ModelItem]).map((item) => (
                          <option key={item.id} value={item.id}>
                            {item.id}
                          </option>
                        ))}
                      </select>
                      <select value={pipelineImageSize} onChange={(event) => setPipelineImageSize(event.target.value)} title="出图尺寸">
                        <option value="1024x1024">1024x1024</option>
                        <option value="1024x1792">1024x1792</option>
                        <option value="1792x1024">1792x1024</option>
                      </select>
                    </>
                  ) : null}
                </div>
              </div>
            ) : null}

            <div className={`composer-box ${mode === 'video' ? 'composer-box-video' : ''}`}>
              {mode === 'video' ? (
                <div className="video-composer-side">
                  <input
                    ref={refFileInputRef}
                    type="file"
                    accept="image/*"
                    multiple
                    hidden
                    onChange={(event) => {
                      void addReferenceFiles(event.target.files);
                      event.currentTarget.value = '';
                    }}
                  />

                  <div
                    className={`ref-stack ${videoRefs.length > 1 ? 'multi' : ''} ${refStackExpanded || videoRefs.length <= 1 ? 'expanded' : ''}`}
                    onMouseEnter={() => {
                      if (videoRefs.length > 1) setRefStackExpanded(true);
                    }}
                    onMouseLeave={() => {
                      if (videoRefs.length > 1) setRefStackExpanded(false);
                    }}
                  >
                    {videoRefs.length ? (
                      videoRefs.map((item, index) => (
                        <div
                          className="ref-stack-card"
                          key={item.id}
                          style={
                            videoRefs.length > 1 && !refStackExpanded
                              ? {
                                  transform: `translate(${index * 8}px, ${index * 6}px) rotate(${index % 2 === 0 ? -2 : 2}deg)`,
                                  zIndex: index + 1
                                }
                              : { zIndex: index + 1 }
                          }
                          title={`@图片${index + 1} · ${item.name}`}
                        >
                          <button className="ref-stack-thumb" type="button" onClick={() => setPreviewImage(item.previewUrl)}>
                            <img src={item.previewUrl} alt={item.name} />
                          </button>
                          <button
                            className="ref-stack-remove"
                            type="button"
                            title="移除"
                            onClick={(event) => {
                              event.stopPropagation();
                              removeReference(item.id);
                            }}
                          >
                            ?
                          </button>
                          <span className="ref-stack-badge">@图片{index + 1}</span>
                        </div>
                      ))
                    ) : (
                      <button
                        className="ref-stack-empty"
                        type="button"
                        disabled={refBusy}
                        onClick={() => refFileInputRef.current?.click()}
                        title="上传参考图"
                      >
                        <span>+</span>
                      </button>
                    )}

                    {videoRefs.length ? (
                      <button
                        className="ref-stack-add"
                        type="button"
                        disabled={refBusy || videoRefs.length >= 7}
                        onClick={() => refFileInputRef.current?.click()}
                        title="继续添加参考图"
                      >
                        +
                      </button>
                    ) : null}
                  </div>

                  <div className="ref-side-actions">
                    {videoRefs.length ? (
                      <button className="ghost-btn tiny-btn" type="button" onClick={clearReferences}>
                        清空
                      </button>
                    ) : null}
                    <button
                      className="ghost-btn tiny-btn"
                      type="button"
                      disabled={refBusy}
                      onClick={() => setAssetPickerOpen((open) => !open)}
                      title="素材 / @ 引用"
                    >
                      素材
                    </button>
                  </div>
                </div>
              ) : null}

              <div className="composer-main">
                {mode === 'video' ? (
                  <div className="composer-hint">
                    使用 <code>@</code> 快速调用参考内容，例如：@图片1 模仿 @视频1 的动作
                  </div>
                ) : null}
                <div className={`composer-input-shell ${mode === 'video' ? 'is-video' : ''}`}>
                  <div className="composer-highlight" aria-hidden="true">
                    {renderComposerHighlight(composer)}
                  </div>
                  <textarea
                    ref={composerTextareaRef}
                    value={composer}
                    onScroll={(event) => {
                      const shell = event.currentTarget.previousElementSibling as HTMLElement | null;
                      if (shell) {
                        shell.scrollTop = event.currentTarget.scrollTop;
                        shell.scrollLeft = event.currentTarget.scrollLeft;
                      }
                    }}
                    onChange={(event) => {
                      const value = event.target.value;
                      const cursor = event.target.selectionStart ?? value.length;
                      setComposer(value);
                      updateMentionStateFromComposer(value, cursor);
                    }}
                    onClick={(event) => {
                      const target = event.currentTarget;
                      updateMentionStateFromComposer(target.value, target.selectionStart ?? target.value.length);
                    }}
                    onKeyUp={(event) => {
                      const target = event.currentTarget;
                      updateMentionStateFromComposer(target.value, target.selectionStart ?? target.value.length);
                    }}
                    onKeyDown={onComposerKeyDown}
                    placeholder={
                      mode === 'video'
                        ? '输入 @ 选择参考图，例如：@角色图 镜头推进...'
                        : modeMeta[mode].placeholder
                    }
                  />
                  {mode === 'video' && mentionOpen ? (
                    <div className="mention-popover">
                      <div className="mention-popover-title">选择图片插入 @ 占位</div>
                      {filteredMentionCandidates.length ? (
                        <div className="mention-list">
                          {filteredMentionCandidates.map((item, index) => (
                            <button
                              key={item.key}
                              type="button"
                              className={`mention-item ${index === mentionIndex ? 'active' : ''}`}
                              onMouseDown={(event) => {
                                event.preventDefault();
                                void selectMentionCandidate(item);
                              }}
                            >
                              <img src={item.src} alt={item.name} />
                              <span className="mention-item-meta">
                                <strong>@{item.name}</strong>
                                <small>{item.kind === 'upload' ? '已上传参考图' : '历史图片'}</small>
                              </span>
                            </button>
                          ))}
                        </div>
                      ) : (
                        <div className="mention-empty">
                          暂无可选图片。请先上传参考图，或从历史图片添加。
                          <button
                            type="button"
                            className="ghost-btn tiny-btn"
                            onMouseDown={(event) => {
                              event.preventDefault();
                              closeMentionPicker();
                              refFileInputRef.current?.click();
                            }}
                          >
                            上传图片
                          </button>
                        </div>
                      )}
                    </div>
                  ) : null}
                </div>

                {mode === 'video' && assetPickerOpen ? (
                  <div className="asset-picker">
                    <div className="asset-picker-header">
                      <strong>@ 素材</strong>
                      <button className="ghost-btn tiny-btn" type="button" onClick={() => setAssetPickerOpen(false)}>
                        关闭
                      </button>
                    </div>

                    <div className="asset-section">
                      <div className="asset-section-title">当前参考图</div>
                      {videoRefs.length ? (
                        <div className="asset-grid">
                          {videoRefs.map((item, index) => (
                            <button
                              key={item.id}
                              className="asset-item"
                              type="button"
                              title={item.name}
                              onClick={() => {
                                void selectMentionCandidate({
                                  key: `ref_${item.id}`,
                                  id: item.id,
                                  name: item.name || `图片${index + 1}`,
                                  src: item.previewUrl || item.apiUrl,
                                  kind: 'upload',
                                  ref: item
                                });
                              }}
                            >
                              <img src={item.previewUrl} alt={item.name} />
                              <span>@图片{index + 1}</span>
                            </button>
                          ))}
                        </div>
                      ) : (
                        <div className="asset-empty">还没有参考图，可先上传</div>
                      )}
                    </div>

                    <div className="asset-section">
                      <div className="asset-section-title">历史图片</div>
                      {historyImageCandidates.length ? (
                        <div className="asset-grid">
                          {historyImageCandidates.map((item, index) => (
                            <button
                              key={item.key}
                              className="asset-item"
                              type="button"
                              title={item.label}
                              onClick={() => {
                                void selectMentionCandidate({
                                  key: `hist_${item.key}`,
                                  id: `hist:${item.key}`,
                                  name: item.label || `素材${index + 1}`,
                                  src: item.src,
                                  kind: 'history',
                                  messageId: item.messageId
                                });
                              }}
                            >
                              <img src={item.src} alt={item.label} />
                              <span>@{item.label.slice(0, 10)}</span>
                            </button>
                          ))}
                        </div>
                      ) : (
                        <div className="asset-empty">暂无历史图片</div>
                      )}
                    </div>

                    <div className="asset-section asset-tools">
                      <button className="ghost-btn" type="button" disabled={refBusy} onClick={() => refFileInputRef.current?.click()}>
                        上传图片
                      </button>
                      <div className="reference-url-row">
                        <input
                          className="system-input"
                          value={videoRefUrlInput}
                          onChange={(event) => setVideoRefUrlInput(event.target.value)}
                          placeholder="粘贴图片 URL / data:image..."
                        />
                        <button className="ghost-btn" type="button" disabled={refBusy} onClick={() => void addReferenceFromUrl()}>
                          添加 URL
                        </button>
                      </div>
                    </div>
                  </div>
                ) : null}

                <div className="composer-actions">
                  {mode === 'video' ? (
                    <button
                      className="ghost-btn mention-btn"
                      type="button"
                      onClick={() => setAssetPickerOpen((open) => !open)}
                      title="@ 素材"
                    >
                      @
                    </button>
                  ) : null}
                  {sending ? (
                    <button className="ghost-btn" onClick={stopGeneration}>
                      停止
                    </button>
                  ) : null}
                  <button className="primary-btn" onClick={() => void sendMessage()} disabled={sending || !composer.trim()}>
                    {sending ? '发送中...' : '发送'}
                  </button>
                </div>
              </div>
            </div>

            {error ? <div className="error-banner">{error}</div> : null}
          </footer>
        </main>
      </div>

      {previewImage ? (
        <div className="lightbox" onClick={() => setPreviewImage('')}>
          <div className="lightbox-card" onClick={(event) => event.stopPropagation()}>
            <img src={previewImage} alt="preview" />
            <div className="row-actions">
              <a className="primary-btn" href={previewImage} target="_blank" rel="noreferrer">
                新窗口打开
              </a>
              <button className="ghost-btn" onClick={() => void handleCopy(previewImage)}>
                复制链接
              </button>
              <button className="ghost-btn" onClick={() => setPreviewImage('')}>
                关闭
              </button>
            </div>
          </div>
        </div>
      ) : null}

      {previewVideo ? (
        <div className="lightbox" onClick={() => setPreviewVideo('')}>
          <div className="lightbox-card video-lightbox" onClick={(event) => event.stopPropagation()}>
            <video
              className="video-player lightbox-video"
              src={previewVideo.startsWith('blob:') || previewVideo.startsWith('data:') || previewVideo.startsWith('/__proxy/media') ? previewVideo : resolvePlayableVideoUrl(previewVideo, undefined, true)}
              controls
              autoPlay
              playsInline
            />
            <div className="row-actions">
              <button className="primary-btn" onClick={() => void handleDownloadVideo(previewVideo.startsWith('blob:') || previewVideo.startsWith('/__proxy/media') ? previewVideo : previewVideo, undefined)}>
                下载到本地
              </button>
              <a className="ghost-btn" href={previewVideo} target="_blank" rel="noreferrer">
                新窗口打开
              </a>
              <button className="ghost-btn" onClick={() => void handleCopy(previewVideo)}>
                复制链接
              </button>
              <button className="ghost-btn" onClick={() => setPreviewVideo('')}>
                关闭
              </button>
            </div>
          </div>
        </div>
      ) : null}

      {toast ? <div className="toast">{toast}</div> : null}
    </div>
  );
}
