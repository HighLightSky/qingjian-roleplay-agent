import { proxy } from "@/lib/server-proxy";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
async function forward(
  request: Request,
  context: { params: Promise<{ path: string[] }> },
) {
  const { path } = await context.params;
  return proxy(request, `/api/${path.map(encodeURIComponent).join("/")}`);
}
export const GET = forward;
export const POST = forward;
export const PUT = forward;
