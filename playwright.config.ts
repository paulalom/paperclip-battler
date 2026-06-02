import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./tests/integration",
  timeout: 60_000,
  expect: {
    timeout: 15_000
  },
  fullyParallel: false,
  workers: 1,
  use: {
    baseURL: "http://127.0.0.1:5174",
    trace: "on-first-retry",
    screenshot: "only-on-failure",
    video: "retain-on-failure"
  },
  webServer: [
    {
      command: "npm run dev",
      url: "http://127.0.0.1:5174/",
      reuseExistingServer: !process.env.CI,
      timeout: 30_000
    },
    {
      command: "npm run mcp:dev",
      url: "http://127.0.0.1:8787/health",
      reuseExistingServer: !process.env.CI,
      timeout: 30_000,
      env: {
        PAPERCLIP_DEFAULT_ATTRACT: "0",
        PAPERCLIP_PROCESS_TITLE: "paperclip-battler-mcp-test"
      }
    }
  ],
  projects: [
    {
      name: "chromium",
      use: {
        browserName: "chromium",
        viewport: { width: 1440, height: 960 }
      }
    }
  ]
});
