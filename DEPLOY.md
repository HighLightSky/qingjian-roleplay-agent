# 启动命令

以下命令均在项目根目录执行。

## 0. 信任外部服务证书

模型服务和生图服务使用 HTTPS 证书，部署机必须先信任 `cert/qwen-lan-ca.crt` 和 `cert/server.crt`。服务在本机部署时同样需要导入。

```bash
# 系统信任库：curl 等工具使用
sudo cp cert/qwen-lan-ca.crt /usr/local/share/ca-certificates/qwen-lan-ca.crt
sudo cp cert/server.crt /usr/local/share/ca-certificates/roleplay-server.crt
sudo update-ca-certificates

# JVM 信任库：后端调用模型服务和生图服务使用
# keytool 必须来自启动后端的同一个 JDK；JDK 在系统目录时给这些命令加 sudo
"$JAVA_HOME/bin/keytool" -delete -alias qwen-lan-ca -cacerts -storepass changeit 2>/dev/null || true
"$JAVA_HOME/bin/keytool" -delete -alias roleplay-server -cacerts -storepass changeit 2>/dev/null || true
"$JAVA_HOME/bin/keytool" -importcert -noprompt -alias qwen-lan-ca \
  -file cert/qwen-lan-ca.crt -cacerts -storepass changeit
"$JAVA_HOME/bin/keytool" -importcert -noprompt -alias roleplay-server \
  -file cert/server.crt -cacerts -storepass changeit
```

`server.crt` 是自签名证书，SAN 为 `localhost`、`127.0.0.1`、`0.0.0.0`、`10.21.16.197`，访问地址的主机名必须在其中；`qwen-lan-ca.crt` 是根 CA，签发对象不限主机名。

## 1. 启动 nginx（443 -> 127.0.0.1:3000）

```bash
sudo cp deploy/nginx/roleplay.conf /etc/nginx/sites-available/roleplay.conf
sudo ln -sfn /etc/nginx/sites-available/roleplay.conf /etc/nginx/sites-enabled/roleplay.conf
sudo nginx -t
sudo systemctl enable --now nginx
sudo systemctl reload nginx
```

也可以把配置直接放到 `/etc/nginx/conf.d/roleplay.conf`，无需创建软链接。

证书位于 `/etc/nginx/tls/roleplay.crt` 和 `/etc/nginx/tls/roleplay.key`。

## 2. 启动后端（8080，LLM 指向 10080）

```bash
LLM_BASE_URL=http://127.0.0.1:10080/v1/chat/completions mvn spring-boot:run
```

## 3. 启动前端（3000）

```bash
cd frontend
npm run build
BACKEND_URL=http://127.0.0.1:8080 npm start -- -H 127.0.0.1 -p 3000
```

开发模式可跳过构建：

```bash
cd frontend
BACKEND_URL=http://127.0.0.1:8080 npm run dev -- -H 127.0.0.1 -p 3000
```

## 4. 检查

```bash
ss -ltn | grep -E ':(443|3000|8080|10080)\b'
curl -kI https://10.21.16.197/
```

浏览器访问 `https://10.21.16.197`，自签证书需确认一次。

## 5. 按顺序关闭服务

```bash
# 1. 关闭 nginx 的 443 转发（释放 443，nginx 仍保留在 80）
sudo unlink /etc/nginx/sites-enabled/roleplay.conf
sudo nginx -t
sudo systemctl reload nginx

# 2. 关闭前端（3000）
fuser -k -TERM 3000/tcp

# 3. 关闭后端（8080）
fuser -k -TERM 8080/tcp
```

如需连 nginx 一起停止：

```bash
sudo systemctl stop nginx
```

确认端口已释放：

```bash
ss -ltn | grep -E ':(443|3000|8080)\b' || echo "已全部关闭"
```

如果配置是直接放到 `/etc/nginx/conf.d/roleplay.conf`，第 1 步改为 `sudo rm /etc/nginx/conf.d/roleplay.conf` 后再 reload。服务在 tmux 会话中运行时，也可以直接在该会话按 `Ctrl-C`。

## 剧情图服务

后端设置 `IMAGE_SERVICE_BASE_URL`（默认内网 HTTPS 地址）和 `IMAGE_SERVICE_API_TOKEN`。Token 只配置在后端；未配置时聊天正常，生图按钮会提示未启用。服务证书信任见第 0 步，不能关闭 TLS 校验。

远端代理必须放行 `/api/image/edit/{task_id}/cancel`，且该路由不占用生成连接配额。应用停止按钮使用另一条连接发送取消，原生成连接继续等待 `409 TASK_CANCELLED`；收到 `202` 时仍显示取消中。

浏览器关闭不停止后台生成，任务结果默认保留两小时。后端重启不保留在途任务与临时结果。升级前先在旧版“完整备份 → 导出全部”保存浏览器数据，按 `docs/15-剧情图开发与数据迁移计划.md` 同步发布前后端。不要用旧前端打开升级后的 v10 库。

生图固定使用后端黑色画布作为第一张输入，默认 256 × 512，按 32 像素向上对齐。宽高和对齐值读取 roleplay.image-generation.default-width/default-height/dimension-alignment；黑图占用一个图片名额，人物照片和历史图为可选参考且允许压缩。新版数据库 v10，备份 v11，旧 v8/v9 数据库及 v9/v10 备份在入口迁移。
