import { defineConfig, devices } from "@playwright/test";
import path from "node:path";

const voiceFixture = path.join(__dirname, "fixtures", "what-time-is-it.wav");

export default defineConfig({
  testDir: ".",
  timeout: 60_000,
  // The 3D core is software-rendered (SwiftShader) in CI, which slows the main thread.
  expect: { timeout: 10_000 },
  fullyParallel: false,
  workers: 1, // specs share one owner account and run in order
  retries: process.env.CI ? 1 : 0,
  reporter: [["list"]],
  use: {
    baseURL: "http://127.0.0.1:8100",
    trace: "off",
    screenshot: "only-on-failure",
    launchOptions: {
      args: [
        "--use-gl=angle",
        "--use-angle=swiftshader",
        "--enable-unsafe-swiftshader",
        "--ignore-gpu-blocklist",
        "--use-fake-ui-for-media-stream",
        "--use-fake-device-for-media-stream",
        `--use-file-for-fake-audio-capture=${voiceFixture}`,
        "--autoplay-policy=no-user-gesture-required",
      ],
    },
  },
  projects: [
    { name: "desktop", use: { ...devices["Desktop Chrome"], viewport: { width: 1600, height: 960 }, permissions: ["microphone"] } },
  ],
  webServer: {
    command: "bash start-server.sh",
    url: "http://127.0.0.1:8100/api/health",
    reuseExistingServer: false,
    timeout: 120_000,
    stdout: "ignore",
    stderr: "pipe",
  },
});
