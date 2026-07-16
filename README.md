# Grok2API Studio

独立的 AI 生成工作台：对话 / 图片 / 视频。  
只依赖公共 `/v1/*` 接口，不依赖后台管理登录。

## 功能

- 文本对话（`/v1/chat/completions`，支持流式）
- 图片生成（`/v1/images/generations`）
- 视频生成与轮询（`/v1/videos/generations` + `/v1/videos/{request_id}`）
- 本地反向代理，规避浏览器 CORS
- 视频预览与本地下载

## 快速开始

```bash
cp .env.example .env
npm install
npm run serve
```

打开：http://127.0.0.1:4175

`.env` 示例：

```env
VITE_API_BASE_URL=
VITE_DEV_PROXY_TARGET=http://127.0.0.1:8000
```

运行时可用环境变量：

- `STUDIO_PROXY_TARGET`：上游 API，例如 `http://154.201.92.160:8000`
- `PORT`：默认 `4175`
- `HOST`：默认 `0.0.0.0`（Docker）/ `127.0.0.1`（本地可改）

## Docker

```bash
docker compose up -d --build
```

或直接拉取镜像：

```bash
docker pull ghcr.io/buttonslaybaugh397-art/ai-studio:latest
docker run --rm -p 4175:4175 \
  -e STUDIO_PROXY_TARGET=http://host.docker.internal:8000 \
  ghcr.io/buttonslaybaugh397-art/ai-studio:latest
```

## 使用说明

1. 打开 Studio
2. 在连接设置中填写 API Key（`g2a_...`）
3. 同步模型
4. 选择对话 / 图片 / 视频模式后生成

视频模式请优先使用 `grok-imagine-video`。

