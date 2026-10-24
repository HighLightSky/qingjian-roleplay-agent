# 图像编辑 API 接口文档

## 1. 地址和鉴权

实际服务部署地址为 `https://10.21.16.104`，只有在局域网内才能访问

以下 curl 示例共用这两个环境变量：

```bash
export API_BASE_URL='http://127.0.0.1:8000'
read -r -s -p '输入部署时配置的 API Token: ' IMAGE_SERVICE_API_TOKEN
export IMAGE_SERVICE_API_TOKEN
```

| 接口 | 用途 | 是否需要 Token |
|---|---|---|
| `GET /health` | FastAPI 进程存活检查 | 否 |
| `GET /ready` | ComfyUI、节点和模型文件就绪检查 | 是 |
| `POST /api/image/edit` | 上传参考图片和提示词，等待生成 PNG | 是 |

需要鉴权时发送请求头：

```http
Authorization: Bearer <API Token>
```

Token 使用服务端 `IMAGE_SERVICE_API_TOKEN` 的值，默认为 comfyUI-qwen-image-21-edit-api-20261024-token

## 2. 存活检查：GET /health

```bash
curl "$API_BASE_URL/health"
```

成功返回 `HTTP 200`、`Content-Type: application/json`：

```json
{"status":"ok"}
```

客户端可以用此接口检查 FastAPI 是否运行；它不检查 ComfyUI 或 GPU，不能据此判断是否可以生图。

## 3. 就绪检查：GET /ready

```bash
curl --fail-with-body "$API_BASE_URL/ready" \
  -H "Authorization: Bearer $IMAGE_SERVICE_API_TOKEN"
```

成功返回 `HTTP 200`、`Content-Type: application/json`：

```json
{"status":"ready"}
```

尚未就绪返回 `HTTP 503`：

```json
{
  "error": {
    "code": "NOT_READY",
    "message": "ComfyUI、节点或模型尚未就绪"
  },
  "request_id": "2edc0f9a-ef81-4eae-87d7-677bd9c0ef91"
}
```

Token 错误返回 401。启动期间可间隔几秒重试 503；持续失败时由部署人员检查服务。此检查不执行推理，不保证显存充足，也不代表队列有空位。

## 4. 图像编辑：POST /api/image/edit

请求格式为 `multipart/form-data`，只有两个业务字段：

| 字段 | 类型 | 说明 |
|---|---|---|
| `images` | 重复的文件字段 | 至少一张 JPEG、PNG 或 WebP；按上传顺序保留前 10 张，其余丢弃 |
| `prompt` | UTF-8 字符串 | 必填且非空；直接用于图像编辑，不自动扩写 |

多张图片重复使用字段名 `images`，不要使用 `images[]`、`image_1` 等名字。第一张是编辑目标，其余是参考图；提示词可用 `<image1>`、`<image2>` 等指明对应图片。不要手动设置 multipart 的 `Content-Type` 请求头，让客户端生成 boundary。

### curl 调用

在客户端当前目录执行；替换两张图片的路径，只上传一张时删除第二个 `images`：

```bash
if HTTP_STATUS=$(curl --silent --show-error \
  "$API_BASE_URL/api/image/edit" \
  -H "Authorization: Bearer $IMAGE_SERVICE_API_TOKEN" \
  -F 'prompt=将 <image2> 中的服装应用到 <image1> 的人物，保持人物身份和背景不变。' \
  -F 'images=@./input/reference-1.jpg' \
  -F 'images=@./input/reference-2.png' \
  --output response.body \
  --write-out '%{http_code}'); then
  if [ "$HTTP_STATUS" = '200' ]; then
    mv response.body result.png
    printf '图片已保存到 result.png\n'
  else
    printf 'HTTP %s\n' "$HTTP_STATUS"
    cat response.body
  fi
fi
```

`@` 后面是 **curl 所在机器上的文件路径**。例如从 ComfyUI 根目录运行时，`./input/a.jpg` 对应 `/home/liu/wzt/ComfyUI/input/a.jpg`，并不是 `/input/a.jpg`。文件无法读取时 curl 报错 26，请求尚未发送。

上述 `response.body` 和 `result.png` 都保存在客户端。示例按 HTTP 状态分别处理，避免把错误 JSON 当作 PNG；如果使用 `curl --fail-with-body --output result.png`，请求失败时也可能把错误正文写进这个文件。

### 成功响应

```http
HTTP/1.1 200 OK
Content-Type: image/png
Cache-Control: no-store
```

响应体为一张完整 PNG 的原始二进制字节。客户端可以直接作为图片显示、交给图像库解码，或保存为 `.png`；不要调用 `response.json()`，也不需要 Base64 解码或再次下载。

输出尺寸依据第一张图片，沿用工作流对齐到 32 倍数的规则，因此不保证与未对齐的原图逐像素同尺寸。一次请求只生成一张图，每次使用新的随机种子。

这是等待生成完成的请求，不返回任务 ID 或下载 URL。当前没有公开的进度、任务查询或取消接口；客户端关闭连接后，服务端会尝试取消并清理对应任务。

### Python 调用并区分两种返回结构

示例使用客户端的 `httpx` 包（可通过 `python -m pip install httpx` 安装）：

```python
import os
from contextlib import ExitStack
from pathlib import Path

import httpx

base_url = os.environ.get("API_BASE_URL", "http://127.0.0.1:8000")
token = os.environ["IMAGE_SERVICE_API_TOKEN"]
paths = [Path("input/reference-1.jpg"), Path("input/reference-2.png")]

with ExitStack() as stack, httpx.Client(timeout=httpx.Timeout(1800.0, connect=10.0)) as client:
    files = [
        ("images", (path.name, stack.enter_context(path.open("rb"))))
        for path in paths
    ]
    response = client.post(
        base_url + "/api/image/edit",
        headers={"Authorization": "Bearer " + token},
        data={"prompt": "参考 <image2> 修改 <image1> 的服装，保持人物身份不变。"},
        files=files,
    )

content_type = response.headers.get("content-type", "").split(";", 1)[0]
if response.status_code == 200 and content_type == "image/png":
    # 发生在调用方机器；也可以直接把 response.content 交给图像库。
    Path("result.png").write_bytes(response.content)
    print("图片已保存到 result.png")
elif content_type == "application/json":
    result = response.json()
    error = result.get("error", {})
    print(response.status_code, error.get("code"), error.get("message"), result.get("request_id"))
else:
    # Nginx 自身拒绝请求时可能返回 HTML 或其他格式。
    print("请求失败：", response.status_code, response.reason_phrase)
```

### 默认限制

实际限制由部署配置决定；当前默认值如下：

| 项目 | 默认值 |
|---|---|
| 保留图片数 | 前 10 张；没有图片则拒绝 |
| 单张保留图片大小 | 16 MiB |
| 整个请求大小 | 128 MiB，包含被丢弃的图片和 multipart 开销 |
| 单张图片像素数 / 最长边 | 4,194,304 像素 / 8192 像素 |
| 保留图片总像素数 | 16,777,216 像素 |
| 提示词长度 | 最多 16,384 个字符 |
| multipart 字段数 | 最多 64 个，包含 prompt 和被丢弃图片的字段 |
| 输出 PNG 大小 | 最多 64 MiB |
| 同时执行 / 等待队列 | 1 / 2；上传与响应传输也占用准入名额 |
| 上传 / 排队等待 / 执行上限 | 60 / 600 / 900 秒 |

超过 10 张不代表请求大小可以无限增加。多图请求可能等待数分钟，建议客户端读取超时至少 1800 秒。连接中断或超时后，不要立即无条件重复提交；新请求会重新生成，结果也可能不同。

## 5. 错误结构与处理

应用错误通常返回 `Content-Type: application/json` 和以下结构：

```json
{
  "error": {
    "code": "QUEUE_FULL",
    "message": "服务繁忙，请稍后重试"
  },
  "request_id": "2edc0f9a-ef81-4eae-87d7-677bd9c0ef91"
}
```

| 字段 | 使用方法 |
|---|---|
| `error.code` | 用于程序分支判断的错误码 |
| `error.message` | 简短说明，可展示给调用者；不要依赖具体措辞写程序逻辑 |
| `request_id` | 本次失败请求的标识，用于反馈问题；不能用于查询或下载结果 |

| HTTP 状态 | 错误码 | 调用方处理 |
|---|---|---|
| 400 | `INVALID_MULTIPART`、`INVALID_PROMPT` | 检查字段名、文件数量、UTF-8 和提示词内容 |
| 401 | `UNAUTHORIZED` | 检查 Token 是否设置、是否与服务端一致 |
| 408 | `UPLOAD_TIMEOUT` | 检查上传连接或减少本次数据量 |
| 413 | `REQUEST_TOO_LARGE`、`PART_TOO_LARGE`、`IMAGE_TOO_LARGE`、`TOO_MANY_PIXELS`、`TOO_MANY_PARTS`、`HEADERS_TOO_LARGE` | 减少大小、像素数或字段数，或联系部署人员调整限制 |
| 422 | `INVALID_IMAGE`、`WORKFLOW_REJECTED` | 前者检查图片能否解码；后者由部署人员检查工作流 |
| 429 | `QUEUE_FULL`、`MEMORY_BUSY` | 降低并发，等待一段时间后再尝试 |
| 499 | `CLIENT_DISCONNECTED` | 客户端已取消或断开，通常收不到该响应 |
| 500 | `INTERNAL_ERROR` | 保留 request_id，反馈部署人员 |
| 502 | `COMFY_UNAVAILABLE`、`EXECUTION_FAILED`、`SERVICE_STOPPING`、`CLEANUP_FAILED` | 等待服务恢复并检查 `/ready`，持续失败时反馈部署人员 |
| 502 | `COMFY_PROTOCOL`、`WEBSOCKET_CLOSED`、`MISSING_OUTPUT`、`INVALID_OUTPUT`、`MULTIPLE_OUTPUTS` | 没有可用结果，反馈部署人员检查上游连接或输出 |
| 503 | `NOT_READY` | `/ready` 未就绪，稍后检查 |
| 504 | `QUEUE_TIMEOUT`、`EXECUTION_TIMEOUT` | 排队或执行超过上限，降低负载或联系部署人员 |

代理自身的 413、429、502、504 不保证使用以上 JSON 结构。先检查 HTTP 状态和 `Content-Type`；网络断开时也可能没有完整响应，不能将收到的部分数据视为成功 PNG。
