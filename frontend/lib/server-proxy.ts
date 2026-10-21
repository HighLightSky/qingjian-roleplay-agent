const MAX_BODY = 64 * 1024 * 1024;
export async function proxy(request: Request, path: string) {
  const backend = (process.env.BACKEND_URL || "http://127.0.0.1:8080").replace(
    /\/$/,
    "",
  );
  try {
    let body: Uint8Array | undefined;
    if (request.method !== "GET" && request.body) {
      const reader = request.body.getReader();
      const chunks: Uint8Array[] = [];
      let size = 0;
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.length;
        if (size > MAX_BODY) {
          await reader.cancel();
          return Response.json(
            { code: "REQUEST_TOO_LARGE", message: "请求体不能超过 64 MiB。" },
            { status: 413 },
          );
        }
        chunks.push(value);
      }
      body = new Uint8Array(size);
      let offset = 0;
      for (const chunk of chunks) {
        body.set(chunk, offset);
        offset += chunk.length;
      }
    }
    const upstream = await fetch(`${backend}${path}`, {
      method: request.method,
      headers: {
        "Content-Type": "application/json",
        Accept: path === "/api/chat" ? "text/event-stream" : "application/json",
      },
      body: body as BodyInit | undefined,
      signal: request.signal,
      cache: "no-store",
    });
    return new Response(upstream.body, {
      status: upstream.status,
      headers: {
        "Content-Type":
          upstream.headers.get("content-type") ?? "application/json",
        "Cache-Control": "no-store, no-transform",
        "X-Accel-Buffering": "no",
      },
    });
  } catch {
    return Response.json(
      {
        code: "CHAT_SERVICE_UNAVAILABLE",
        message: "无法连接聊天服务，请确认后端已启动且 BACKEND_URL 配置正确。",
      },
      { status: 502 },
    );
  }
}
