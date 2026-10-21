import { proxy } from "@/lib/server-proxy";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export async function POST(request: Request) {
  return proxy(request, "/api/chat");
}
