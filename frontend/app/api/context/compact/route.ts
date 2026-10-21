import { proxy } from "@/lib/server-proxy";
export const runtime = "nodejs";
export async function POST(request: Request) {
  return proxy(request, "/api/context/compact");
}
