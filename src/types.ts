export type StudioMode = 'chat' | 'image' | 'video';

export type ConnectionMode = 'proxy' | 'direct';

export type ModelItem = {
  id: string;
  object?: string;
  owned_by?: string;
  created?: number;
};

export type AppConfig = {
  /** empty = same-origin / local proxy */
  baseUrl: string;
  apiKey: string;
  /** proxy: always request same-origin /v1 via local reverse proxy */
  connectionMode: ConnectionMode;
  /** upstream used by local proxy when connectionMode=proxy */
  proxyTarget: string;
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
  video?: {
    id?: string;
    status?: string;
    url?: string;
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
  progress?: number;
  error?: string;
  raw: unknown;
};
