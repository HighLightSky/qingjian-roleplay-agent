import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./tests/e2e",
  timeout: 45_000,
  fullyParallel: false,
  workers: 1,
  use: {
    baseURL: "http://127.0.0.1:3100",
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
      url: "http://127.0.0.1:18080/health",
      reuseExistingServer: !process.env.CI,
    },
    {
      command: "npm run dev -- --hostname 0.0.0.0 --port 3100",
      url: "http://127.0.0.1:3100",
      env: { BACKEND_URL: "http://127.0.0.1:18080" },
      reuseExistingServer: !process.env.CI,
      timeout: 90_000,
    },
  ],
});
