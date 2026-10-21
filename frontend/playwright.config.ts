import { defineConfig } from "@playwright/test";

const port = process.env.ROLEPLAY_E2E_PORT ?? "3100";
const backendPort = process.env.ROLEPLAY_E2E_BACKEND_PORT ?? "18080";
const baseURL = `http://127.0.0.1:${port}`;
const backendURL = `http://127.0.0.1:${backendPort}`;

export default defineConfig({
  testDir: "./tests/e2e",
  timeout: 45_000,
  fullyParallel: false,
  workers: 1,
  use: {
    baseURL,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  projects: [
    {
      name: "desktop",
      use: { browserName: "chromium", viewport: { width: 1440, height: 1000 } },
    },
    {
      name: "mobile",
      use: {
        browserName: "chromium",
        viewport: { width: 390, height: 844 },
        isMobile: true,
        hasTouch: true,
      },
    },
  ],
  webServer: [
    {
      command: "node tests/mock-chat.mjs",
      url: `${backendURL}/health`,
      env: { ROLEPLAY_E2E_BACKEND_PORT: backendPort },
      reuseExistingServer: !process.env.CI,
    },
    {
      command: `npm run dev -- --hostname 0.0.0.0 --port ${port}`,
      url: baseURL,
      env: { BACKEND_URL: backendURL },
      reuseExistingServer: !process.env.CI,
      timeout: 90_000,
    },
  ],
});
