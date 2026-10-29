import { withAui } from "@assistant-ui/next";
import type { NextConfig } from "next";
import { networkInterfaces } from "node:os";

// Next dev also validates HMR's Origin, even when the page is opened on this
// machine's LAN address. Allow the local interfaces rather than a wildcard.
const localAddresses = Object.values(networkInterfaces()).flatMap((addresses) =>
  (addresses ?? [])
    .filter((address) => address.family === "IPv4")
    .map((address) => address.address),
);
const additionalHosts = (process.env.DEV_ALLOWED_ORIGINS ?? "")
  .split(",")
  .map((host) => host.trim())
  .filter(Boolean);

const nextConfig: NextConfig = {
  // 独立测试构建目录，避免覆盖正在运行的开发服务产物。
  distDir: process.env.ROLEPLAY_DIST_DIR ?? ".next",
  async headers() {
    return [
      {
        source: "/vendor/vnccs/:revision/:path*",
        headers: [
          {
            key: "Cache-Control",
            value: "public, max-age=31536000, immutable",
          },
        ],
      },
    ];
  },
  allowedDevOrigins: [
    ...new Set(["127.0.0.1", ...localAddresses, ...additionalHosts]),
  ],
};

export default withAui(nextConfig);
