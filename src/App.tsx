import { useEffect, useMemo, useRef, useState } from 'react';
import {
  downloadRemoteFile,
  fetchModels,
  fetchVideoStatus,
  generateChat,
  generateImage,
  generateVideo,
  imageSrc,
  mediaProxyUrl,
  streamChat
} from './api';
import type {
  AppConfig,
  ModelItem,
  StudioConversation,
  StudioMessage,
  StudioMode
} from './types';

const CONFIG_KEY = 'grok-studio-config-v2';
const HISTORY_KEY = 'grok-studio-history-v2';

const DEFAULT_BASE_URL = (import.meta as ImportMeta & {
  env?: { VITE_API_BASE_URL?: string };
}).env?.VITE_API_BASE_URL?.trim() || '';

const DEFAULT_PROXY_TARGET = (import.meta as ImportMeta & {
  env?: { VITE_DEV_PROXY_TARGET?: string };
}).env?.VITE_DEV_PROXY_TARGET?.trim() || 'http://154.201.92.160:8000';

const defaultConfig: AppConfig = {
  baseUrl: DEFAULT_BASE_URL,
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
    endpoint: 'POST /v1/videos/generations',
    preferred: 'grok-imagine-video',
    placeholder: '描述镜头、主体、运动与氛围...',
    hint: '提交后自动轮询任务状态'
  }
};

function uid(prefix = 'id') {
  return `${prefix}_${Math.random().toString(36).slice(2, 10)}_${Date.now().toString(36)}`;
}

function loadConfig(): AppConfig {
  try {
    const saved = JSON.parse(localStorage.getItem(CONFIG_KEY) || '{}') || {};
    const merged: AppConfig = {
      ...defaultConfig,
      ...saved,
      connectionMode: saved.connectionMode === 'direct' ? 'direct' : 'proxy',
      proxyTarget: String(saved.proxyTarget || defaultConfig.proxyTarget || '').trim() || defaultConfig.proxyTarget,
      baseUrl: String(saved.baseUrl || '').trim(),
      apiKey: String(saved.apiKey || '').trim()
    };
    if (merged.connectionMode === 'proxy') {
      merged.baseUrl = '';
    }
    return merged;
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

function resolvePlayableVideoUrl(url?: string) {
  if (!url) return '';
  // Keep original URL for playback first; browser can usually stream cross-origin video.
  return url;
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
  const [videoDuration, setVideoDuration] = useState('8');
  const [videoAspectRatio, setVideoAspectRatio] = useState('16:9');
  const [videoResolution, setVideoResolution] = useState('720p');
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
    (config.connectionMode === 'proxy'
      ? Boolean((config.proxyTarget || '').trim())
      : Boolean(config.baseUrl.trim()) && /^https?:\/\//i.test(config.baseUrl.trim()));
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
    localStorage.setItem(HISTORY_KEY, JSON.stringify(conversations));
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
    const userMessage: StudioMessage = {
      id: uid('msg'),
      role: 'user',
      mode,
      content,
      status: 'done',
      createdAt: Date.now()
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
        const result = await generateVideo(config, {
          model: requestModel,
          prompt: content,
          duration: videoDuration,
          aspectRatio: videoAspectRatio,
          resolution: videoResolution
        });
        const requestId = result.id || result.request_id || '';
        updateConversation(conversationId, (item) => ({
          ...item,
          updatedAt: Date.now(),
          messages: item.messages.map((message) =>
            message.id === assistantId
              ? {
                  ...message,
                  content: requestId ? `视频任务已提交：${requestId}` : '视频任务已提交，正在轮询状态...',
                  status: 'pending',
                  video: {
                    id: requestId || undefined,
                    status: result.status || 'submitted'
                  },
                  raw: result
                }
              : message
          )
        }));
        if (requestId) {
          await pollVideoIntoMessage(conversationId, assistantId, requestId);
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
    for (let attempt = 0; attempt < 45; attempt += 1) {
      try {
        const status = await fetchVideoStatus(config, requestId);
        const normalized = String(status.status || '').toLowerCase();
        const isDone = Boolean(status.url) || normalized === 'done';
        const isFailed = normalized === 'failed';
        const progressText =
          typeof status.progress === 'number' ? ` · 进度 ${status.progress}%` : '';

        updateConversation(conversationId, (item) => ({
          ...item,
          updatedAt: Date.now(),
          messages: item.messages.map((message) =>
            message.id === messageId
              ? {
                  ...message,
                  content: isDone
                    ? '视频已生成完成'
                    : isFailed
                      ? `视频生成失败${status.error ? `：${status.error}` : ''}`
                      : `视频状态：${status.status || 'pending'}${progressText}（第 ${attempt + 1} 次轮询）`,
                  status: isDone ? 'done' : isFailed ? 'error' : 'pending',
                  error: isFailed ? status.error || `视频失败：${status.status || 'failed'}` : undefined,
                  video: {
                    id: status.id || requestId,
                    status: status.status,
                    url: status.url
                  },
                  raw: status.raw
                }
              : message
          )
        }));

        if (isDone || isFailed) return;
      } catch (requestError) {
        updateConversation(conversationId, (item) => ({
          ...item,
          messages: item.messages.map((message) =>
            message.id === messageId
              ? {
                  ...message,
                  status: 'error',
                  error: requestError instanceof Error ? requestError.message : '视频状态查询失败'
                }
              : message
          )
        }));
        return;
      }
      await new Promise((resolve) => window.setTimeout(resolve, 4000));
    }
    updateConversation(conversationId, (item) => ({
      ...item,
      messages: item.messages.map((message) =>
        message.id === messageId
          ? {
              ...message,
              status: 'error',
              error: '视频轮询超时，请稍后在会话中查看或重新提交。'
            }
          : message
      )
    }));
  }

  function onComposerKeyDown(event: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      void sendMessage();
    }
  }

  async function handleCopy(text: string) {
    await copyText(text);
    showToast('已复制');
  }

  async function handleDownloadVideo(url?: string, requestId?: string) {
    if (!url) {
      showToast('暂无视频地址');
      return;
    }
    const key = requestId || url;
    setDownloadingVideoId(key);
    try {
      await downloadRemoteFile(url, guessVideoFilename(url, requestId));
      showToast('视频已开始下载到本地');
    } catch (error) {
      const message = error instanceof Error ? error.message : '下载失败';
      // Last resort: open in new tab so user can save manually.
      try {
        window.open(mediaProxyUrl(url) || url, '_blank', 'noopener,noreferrer');
      } catch {
        // ignore
      }
      setError(`本地下载失败：${message}。已尝试打开视频地址，可在浏览器中另存为。`);
    } finally {
      setDownloadingVideoId('');
    }
  }

  const connectionLabel = !hasApiKey ? '待配置' : config.connectionMode === 'proxy' ? '本地代理(免跨域)' : '直连(需CORS)';
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
                    value={config.connectionMode}
                    onChange={(event) => {
                      const mode = event.target.value === 'direct' ? 'direct' : 'proxy';
                      setConfig((current) => ({
                        ...current,
                        connectionMode: mode,
                        baseUrl: mode === 'proxy' ? '' : current.baseUrl
                      }));
                    }}
                  >
                    <option value="proxy">本地代理（推荐，免跨域）</option>
                    <option value="direct">直连上游（需要 CORS）</option>
                  </select>
                </label>
                {config.connectionMode === 'proxy' ? (
                  <label>
                    <span>上游 API 地址（代理目标）</span>
                    <input
                      value={config.proxyTarget}
                      onChange={(event) =>
                        setConfig((current) => ({ ...current, proxyTarget: event.target.value }))
                      }
                      placeholder="例如 http://154.201.92.160:8000"
                    />
                  </label>
                ) : (
                  <label>
                    <span>API 地址（直连）</span>
                    <input
                      value={config.baseUrl}
                      onChange={(event) => setConfig((current) => ({ ...current, baseUrl: event.target.value }))}
                      placeholder="例如 http://154.201.92.160:8000（不要带 /v1）"
                    />
                  </label>
                )}
                <label>
                  <span>API Key</span>
                  <input
                    value={config.apiKey}
                    onChange={(event) => setConfig((current) => ({ ...current, apiKey: event.target.value }))}
                    placeholder="Bearer g2a_... / sk-..."
                  />
                </label>
                <div className="hint-box">
                  {config.connectionMode === 'proxy'
                    ? '本地代理模式：浏览器只请求当前站点 /v1/*，由本地反代转发到上游，规避 CORS。'
                    : '直连模式：浏览器直接请求上游。若上游未正确处理 OPTIONS 与 CORS 头，会失败。'}
                </div>
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
                                复制链接
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
                          {message.video.url ? ' · 可预览 / 下载' : ''}
                        </div>
                        {message.video.url ? (
                          <>
                            <div className="video-player-wrap">
                              <video
                                className="video-player"
                                src={resolvePlayableVideoUrl(message.video.url)}
                                controls
                                playsInline
                                preload="metadata"
                                poster=""
                              />
                            </div>
                            <div className="row-actions">
                              <button
                                className="primary-btn"
                                onClick={() => setPreviewVideo(message.video?.url || '')}
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
                              <a className="ghost-btn" href={message.video.url} target="_blank" rel="noreferrer">
                                新窗口打开
                              </a>
                              <button
                                className="ghost-btn"
                                onClick={() => void handleCopy(message.video?.url || '')}
                              >
                                复制链接
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
              <div className="composer-controls">
                <select value={videoDuration} onChange={(event) => setVideoDuration(event.target.value)}>
                  <option value="4">4 秒</option>
                  <option value="8">8 秒</option>
                  <option value="12">12 秒</option>
                </select>
                <select value={videoAspectRatio} onChange={(event) => setVideoAspectRatio(event.target.value)}>
                  <option value="16:9">16:9</option>
                  <option value="9:16">9:16</option>
                  <option value="1:1">1:1</option>
                </select>
                <select value={videoResolution} onChange={(event) => setVideoResolution(event.target.value)}>
                  <option value="720p">720p</option>
                  <option value="1080p">1080p</option>
                </select>
              </div>
            ) : null}

            <div className="composer-box">
              <textarea
                value={composer}
                onChange={(event) => setComposer(event.target.value)}
                onKeyDown={onComposerKeyDown}
                placeholder={modeMeta[mode].placeholder}
              />
              <div className="composer-actions">
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
              src={resolvePlayableVideoUrl(previewVideo)}
              controls
              autoPlay
              playsInline
            />
            <div className="row-actions">
              <button className="primary-btn" onClick={() => void handleDownloadVideo(previewVideo)}>
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
