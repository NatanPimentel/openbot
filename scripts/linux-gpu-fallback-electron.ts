// Electron side of `scripts/linux-gpu-fallback-e2e.ts`. It starts the GPU mode as `src/main/index.ts`
// does and opens a window with a blurred backdrop.
// It writes the state to `--ready-file` when the page has loaded. A "quit" line or the end of stdin
// quits the app, so the app also quits when the test stops.
import { writeFileSync } from "node:fs";
import { app, BrowserWindow } from "electron";
import { configureLinuxGpu } from "../src/main/linux-gpu-mode";

function argument(name: string): string {
  const value = process.argv.find((item) => item.startsWith(`--${name}=`));
  if (!value) throw new Error(`Missing --${name}=`);
  return value.slice(name.length + 3);
}

// A closed output must not stop the test app with an error dialog.
process.stdout.on("error", () => undefined);
process.stderr.on("error", () => undefined);
const userDataPath = argument("user-data");
app.setPath("userData", userDataPath);
const mode = configureLinuxGpu({
  userDataPath,
  ownsInstance: true,
  startConfirmMs: Number(argument("confirm-ms")),
});
// No top-level await: Electron does not get ready until an ESM main module has run to its end.
void app.whenReady().then(async () => {
  const window = new BrowserWindow({ width: 480, height: 320 });
  await window.loadURL(
    `data:text/html,${encodeURIComponent(
      "<body style='margin:0;background:linear-gradient(45deg,#f60,#06f)'>" +
        "<div style='margin:40px;height:200px;backdrop-filter:blur(24px)'>GPU fallback</div></body>",
    )}`,
  );
  writeFileSync(
    argument("ready-file"),
    JSON.stringify({
      pid: process.pid,
      mode,
      hardwareAccelerationEnabled: app.isHardwareAccelerationEnabled(),
      gpuCompositing: app.getGPUFeatureStatus().gpu_compositing,
    }),
  );
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (chunk: string) => {
    if (chunk.includes("quit")) app.quit();
  });
  process.stdin.on("end", () => app.quit());
});
