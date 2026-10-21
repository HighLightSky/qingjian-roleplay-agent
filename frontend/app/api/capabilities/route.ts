import { proxy } from "@/lib/server-proxy";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export async function GET(request: Request) {
  return proxy(request, "/api/capabilities");
}
