import { defineConfig } from "playwright/test";

const PORT = 30178;
// `next dev` binds 127.0.0.1, and macOS resolves `localhost` to ::1 first, so
// the literal address is the only one guaranteed to reach the dev server.
const BASE_URL = `http://127.0.0.1:${PORT}`;

export default defineConfig({
  testDir: "tests/browser",
  // One worker: every test drives the same dev server and the same on-disk
  // session, so parallel pages would fight over one composer's draft.
  workers: 1,
  fullyParallel: false,
  retries: 0,
  reporter: [["list"]],
  timeout: 90_000,
  expect: { timeout: 15_000 },
  use: {
    baseURL: BASE_URL,
    viewport: { width: 1440, height: 900 },
    trace: "retain-on-failure",
  },
  projects: [
    {
      name: "chromium",
      // A real Cmd/Ctrl+V through the engine's own sanitizer is the only paste
      // that exercises the contenteditable="false" guard. Scripting the
      // clipboard needs a permission grant in Blink and a pref in Gecko.
      use: { browserName: "chromium", permissions: ["clipboard-read", "clipboard-write"] },
    },
    {
      name: "firefox",
      use: {
        browserName: "firefox",
        launchOptions: { firefoxUserPrefs: { "dom.events.testing.asyncClipboard": true } },
      },
    },
    { name: "webkit", use: { browserName: "webkit" } },
  ],
  webServer: {
    command: "npm run dev",
    url: BASE_URL,
    reuseExistingServer: true,
    // The dev server probes for the `omp` binary and Next compiles the chat
    // route on first request; cold start is minutes, not seconds.
    timeout: 300_000,
    stdout: "pipe",
    stderr: "pipe",
  },
});
