# 启动命令

以下命令均在项目根目录执行。

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
