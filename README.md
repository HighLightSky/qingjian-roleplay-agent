<div align="center">

<h1>青笺：Roleplay Agent</h1>

<p>与角色相遇，让故事延续。</p>

<p>自定义角色 · 角色长期记忆 · 图片理解 · 剧情生图</p>

<p>
  <img src="https://img.shields.io/badge/Java-21-ED8B00?style=flat-square" alt="Java 21" />
  <img src="https://img.shields.io/badge/Spring_Boot-3-6DB33F?style=flat-square&amp;logo=springboot&amp;logoColor=white" alt="Spring Boot 3" />
  <img src="https://img.shields.io/badge/Next.js-16-000000?style=flat-square&amp;logo=nextdotjs&amp;logoColor=white" alt="Next.js 16" />
  <img src="https://img.shields.io/badge/TypeScript-3178C6?style=flat-square&amp;logo=typescript&amp;logoColor=white" alt="TypeScript" />
  <a href="https://github.com/HighLightSky/qingjian-roleplay-agent/releases">
    <img
      src="https://img.shields.io/github/v/release/HighLightSky/qingjian-roleplay-agent?style=flat-square"
      alt="最新版本"
    />
  </a>
</p>

<p>
  <a href="#快速启动">快速启动</a> ·
  <a href="DEPLOY.md">部署指南</a> ·
  <a href="docs/">项目文档</a>
</p>

</div>

<!-- 将截图保存为 docs/assets/preview.png，删除下方占位提示，并取消图片行的注释。 -->
<!-- ![青笺界面预览](docs/assets/preview.png) -->

> 📷 界面预览位置：可放一张包含角色聊天与剧情图的截图。

## 关于青笺

青笺是一个 AI 角色聊天应用。为角色设定身份、性格与形象，在对话中共同推进故事，让记忆与关系随着交流逐渐积累，也可以将故事中的片刻生成画面。

- **角色与故事**：自定义角色设定与形象，开启不同的故事会话。
- **记忆与延续**：自动整理剧情、记忆和目标，管理长对话上下文。
- **图片与画面**：发送图片供角色理解，编辑提示词与参考图，生成剧情画面。
- **保存与备份**：角色、聊天和图片保存在浏览器本地，支持完整备份与恢复。

## 快速启动

准备 Java 21、Maven、Node.js 20.9+ 和 npm。以下命令从项目根目录开始，在两个终端分别启动后端和前端。

### 后端

将示例地址、模型名称和密钥替换为实际配置：

```bash
export LLM_BASE_URL='http://127.0.0.1:10080/v1/chat/completions'
export LLM_MODEL='你的模型名称'
export LLM_API_KEY='你的模型密钥'
export CONTEXT_WINDOW_TOKENS=193024

export IMAGE_SERVICE_BASE_URL='http://127.0.0.1:8000'
export IMAGE_SERVICE_API_TOKEN='你的生图服务 Token'

mvn spring-boot:run
```

- **LLM 服务**：`LLM_BASE_URL` 填完整的聊天接口地址；服务需支持流式回复、视觉输入、JSON Schema 结构化输出，以及思考开关和 `reasoning_budget_tokens`。同一服务还需提供 `/tokenize` 和 `/apply-template` 接口。`CONTEXT_WINDOW_TOKENS` 按实际部署的上下文窗口填写。
- **生图服务**：`IMAGE_SERVICE_BASE_URL` 只填服务根地址，后端会调用 `/api/image/edit`，使用 `IMAGE_SERVICE_API_TOKEN` 鉴权。需连接符合[生图服务协议](docs/13-生图服务API.md)的服务；暂不使用生图时可将 Token 设为空，不影响聊天。

两类服务均由后端连接，密钥只需配置在后端。使用自签名 HTTPS 时，证书信任配置见[部署指南](DEPLOY.md)。

### 前端

```bash
cd frontend
npm ci
cp .env.example .env.local
npm run dev
```

打开 [http://localhost:3000](http://localhost:3000) 即可使用。前端默认连接 `http://127.0.0.1:8080`；后端位于其他地址时，修改 `frontend/.env.local` 中的 `BACKEND_URL`。

## 了解更多

[部署指南](DEPLOY.md) · [前端说明](frontend/README.md) · [设计与协议文档](docs/)
