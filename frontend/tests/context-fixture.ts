export const contextCapabilities = {
  contextWindowTokens: 193024,
  outputReserveTokens: 8192,
  safetyTokens: 1024,
  compactionTriggerRatio: 0.7,
  compactionTargetRatio: 0.5,
  retainedTurns: 10,
  compactionMaxBatches: 8,
  visionSupported: true,
  mimeTypes: ["image/png", "image/jpeg"],
  maxImages: 4,
  maxImageBytes: 10485760,
  maxPixels: 20000000,
  maxRequestBytes: 67108864,
};
export function contextFixture(path: string, init?: RequestInit) {
  if (path === "/api/capabilities") return Response.json(contextCapabilities);
  if (path !== "/api/context/budget") return;
  const context = JSON.parse(String(init!.body)).context;
  return Response.json({
    inputTokens: 1000,
    contextWindowTokens: 193024,
    usageRatio: 1000 / 193024,
    outputReserveTokens: 8192,
    safetyTokens: 1024,
    accuracy: "exact",
    needsCompaction: false,
    fits: true,
    requestFingerprint: "fixture",
    compactThroughSeq: context.summary.throughSeq,
  });
}
