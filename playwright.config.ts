import { defineConfig, devices } from "@playwright/test";

// Local runs can point at a preinstalled Chromium via PLAYWRIGHT_CHROMIUM_PATH;
// CI uses the browser that `playwright install` fetched.
const chromiumPath = process.env.PLAYWRIGHT_CHROMIUM_PATH;

export default defineConfig({
  testDir: "e2e",
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [["github"], ["list"]] : "list",
  use: {
    baseURL: "http://localhost:3000",
    trace: "retain-on-failure",
  },
  projects: [
    {
      name: "desktop",
      use: {
        ...devices["Desktop Chrome"],
        viewport: { width: 1280, height: 800 },
        launchOptions: chromiumPath ? { executablePath: chromiumPath } : {},
      },
    },
    {
      name: "mobile",
      use: {
        ...devices["Desktop Chrome"],
        viewport: { width: 390, height: 844 },
        isMobile: true,
        hasTouch: true,
        launchOptions: chromiumPath ? { executablePath: chromiumPath } : {},
      },
    },
  ],
  webServer: {
    command: "pnpm start",
    url: "http://localhost:3000/dashboard",
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
  },
});
