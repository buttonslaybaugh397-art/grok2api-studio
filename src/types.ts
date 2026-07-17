export type StudioMode = 'chat' | 'image' | 'video';

export type VideoReferenceSource = 'none' | 'upload' | 'url' | 'history' | 'pipeline';

export type VideoReferenceImage = {
  id: string;
  name: string;
  previewUrl: string;
  /** remote http(s) url or data url used by API */
  apiUrl: string;
  source: Exclude<VideoReferenceSource, 'none'>;
  width?: number;
  height?: number;
  bytes?: number;
  mime?: string;
  fromMessageId?: string;
};


export type ConnectionMode = 'proxy' | 'direct';

export type ModelItem = {
  id: string;
  object?: string;
  owned_by?: string;
  created?: number;
};

export type AppConfig = {
  /** direct mode only: CPA base URL, e.g. http://154.201.92.160:8317 */
  baseUrl: string;
  apiKey: string;
  /** proxy = same-origin /v1 via local reverse proxy (recommended, visible on CPA) */
  connectionMode: ConnectionMode;
  /** upstream CPA used by local proxy */
  proxyTarget?: string;
};

export type ChatMessage = {
  role: 'system' | 'user' | 'assistant';
  content: string;
};

export type StudioMessage = {
  id: string;
  role: 'user' | 'assistant' | 'system';
  mode: StudioMode;
  content: string;
  status: 'pending' | 'streaming' | 'done' | 'error';
  error?: string;
  createdAt: number;
  images?: Array<{ url?: string; b64_json?: string; revised_prompt?: string }>;
  referenceImages?: VideoReferenceImage[];
  video?: {
    id?: string;
    status?: string;
    url?: string;
    duration?: number | string;
    aspectRatio?: string;
    resolution?: string;
    size?: string;
    progress?: number;
    sourceImageCount?: number;
    pipeline?: 'text-to-video' | 'image-to-video' | 'image-then-video';
  };
  raw?: unknown;
};

export type StudioConversation = {
  id: string;
  title: string;
  mode: StudioMode;
  model: string;
  createdAt: number;
  updatedAt: number;
  messages: StudioMessage[];
};

export type ImageResult = {
  created?: number;
  data: Array<{
    url?: string;
    b64_json?: string;
    revised_prompt?: string;
  }>;
  raw: unknown;
};

export type VideoStatusResult = {
  id?: string;
  status?: string;
  output?: unknown;
  url?: string;
  content_path?: string;
  content_url?: string;
  progress?: number;
  duration?: number | string;
  model?: string;
  error?: string;
  raw: unknown;
};

export type VideoGeneratePayload = {
  model: string;
  prompt: string;
  seconds?: string | number;
  duration?: string | number;
  size?: string;
  aspectRatio?: string;
  resolution?: string;
  imageUrl?: string;
  referenceImageUrls?: string[];
  useInputReference?: boolean;
};

