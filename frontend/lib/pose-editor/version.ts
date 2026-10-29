import manifest from "../../scripts/pose-assets.json" with { type: "json" };

export const POSE_RUNTIME_REVISION = manifest.revision;
export const POSE_ASSET_BASE = `/vendor/vnccs/${POSE_RUNTIME_REVISION}`;
