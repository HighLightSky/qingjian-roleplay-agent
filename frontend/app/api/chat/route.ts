import { NextRequest } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Forward the existing backend protocol without buffering or exposing model credentials. */
export async function POST(request: NextRequest) {
  const backend = (process.env.BACKEND_URL || "http://127.0.0.1:8080").replace(
    /\/$/,
    "",
  );
  try {
    const upstream = await fetch(`${backend}/api/chat`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "text/event-stream",
      },
      body: await request.text(),
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
