// #992: on some Linux GPU drivers the GPU process dies with no fallback mode left, and Chromium then
// stops the main process with SIGTRAP ("GPU process isn't usable. Goodbye."). #1046 turned off
// hardware acceleration for every Linux computer, so on the computers whose GPU works, each surface
// that blurs its backdrop also renders on the CPU, frame by frame.
//
// Hardware acceleration now stays on until it fails on this computer. Two files in `userData` keep
// the evidence, because the main process can stop before it sees the GPU process go:
// - `gpu-start.json` is written before the app is ready. It is removed when the app has run for
//   `startConfirmMs`, or when it quits. If the file is there at the next start, that start stopped.
// - `gpu-crash.json` is written when the GPU process crashes.
// Either file keeps software rendering on at each later start with the same Electron version. A new
// Electron version tries the GPU again, because a new Chromium can fix the driver problem.
// `OPENBOT_DISABLE_GPU=1` always uses software rendering. `OPENBOT_DISABLE_GPU=0` always uses the GPU.
// The renderer sandbox stays on in all cases.

import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { isDynamicRecord, isString } from "@openbot/contracts/runtime-values";
import { createOpenBotLogger, toLogValue } from "@openbot/logging";
import { app, type Details } from "electron";
import { isMissingFileError } from "../backend/file-errors";

export const GPU_START_FILE = "gpu-start.json";
export const GPU_CRASH_FILE = "gpu-crash.json";
const DEFAULT_START_CONFIRM_MS = 30_000;
// `killed` and `clean-exit` are a quit or a kill from outside, not a driver failure.
const GPU_FAILURE_REASONS: ReadonlySet<Details["reason"]> = new Set([
  "crashed",
  "abnormal-exit",
  "oom",
  "launch-failed",
]);

const logger = createOpenBotLogger("linux-gpu");

/** One GPU failure on this computer, with the Electron version that had it. */
export interface GpuFailureRecord {
  electron: string;
}

export type LinuxGpuModeReason =
  | "not-linux"
  | "environment-off"
  | "environment-on"
  | "gpu-process-crash"
  | "unfinished-start"
  | "default";

export interface LinuxGpuMode {
  hardwareAcceleration: boolean;
  reason: LinuxGpuModeReason;
}

export interface LinuxGpuModeInput {
  platform: NodeJS.Platform;
  /** The value of `OPENBOT_DISABLE_GPU`. */
  disableGpu: string | undefined;
  electronVersion: string;
  crash: GpuFailureRecord | undefined;
  unfinishedStart: GpuFailureRecord | undefined;
}

/** Decides if this start uses hardware acceleration. It reads no files and changes nothing. */
export function resolveLinuxGpuMode(input: LinuxGpuModeInput): LinuxGpuMode {
  if (input.platform !== "linux") return { hardwareAcceleration: true, reason: "not-linux" };
  if (input.disableGpu === "1") return { hardwareAcceleration: false, reason: "environment-off" };
  if (input.disableGpu === "0") return { hardwareAcceleration: true, reason: "environment-on" };
  if (input.crash?.electron === input.electronVersion) {
    return { hardwareAcceleration: false, reason: "gpu-process-crash" };
  }
  if (input.unfinishedStart?.electron === input.electronVersion) {
    return { hardwareAcceleration: false, reason: "unfinished-start" };
  }
  return { hardwareAcceleration: true, reason: "default" };
}

export interface ConfigureLinuxGpuOptions {
  userDataPath: string;
  /**
   * False in a second instance, which gives its launch to the first instance and exits before it is
   * ready. It must not write the start file: it would never remove it.
   */
  ownsInstance: boolean;
  startConfirmMs?: number;
}

/**
 * Reads the evidence, turns off hardware acceleration when it failed before, and records new
 * failures. Call it before the app is ready and after `userData` has its final path.
 */
export function configureLinuxGpu(options: ConfigureLinuxGpuOptions): LinuxGpuMode {
  const startPath = join(options.userDataPath, GPU_START_FILE);
  const crashPath = join(options.userDataPath, GPU_CRASH_FILE);
  const electronVersion = process.versions.electron ?? "";
  const mode = resolveLinuxGpuMode({
    platform: process.platform,
    disableGpu: process.env.OPENBOT_DISABLE_GPU,
    electronVersion,
    crash: process.platform === "linux" ? readGpuFailure(crashPath) : undefined,
    unfinishedStart: process.platform === "linux" ? readGpuFailure(startPath) : undefined,
  });
  if (mode.reason === "not-linux") return mode;
  if (!mode.hardwareAcceleration) {
    app.disableHardwareAcceleration();
    if (mode.reason !== "environment-off") {
      logger.warn(
        `Software rendering is on because the GPU failed before (${mode.reason}). ` +
          `Remove ${mode.reason === "gpu-process-crash" ? crashPath : startPath} or set OPENBOT_DISABLE_GPU=0 to try the GPU again.`,
      );
    }
    return mode;
  }
  if (!options.ownsInstance) return mode;
  writeGpuFailure(startPath, electronVersion);
  const confirmStart = () => removeFile(startPath);
  void app.whenReady().then(() => setTimeout(confirmStart, options.startConfirmMs ?? DEFAULT_START_CONFIRM_MS));
  app.once("will-quit", confirmStart);
  app.on("child-process-gone", (_event, details) => {
    if (details.type !== "GPU" || !GPU_FAILURE_REASONS.has(details.reason)) return;
    logger.warn(`The GPU process stopped (${details.reason}, exit code ${details.exitCode}).`);
    writeGpuFailure(crashPath, electronVersion);
  });
  return mode;
}

function readGpuFailure(path: string): GpuFailureRecord | undefined {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (error) {
    if (!isMissingFileError(error)) logger.warn(`Unable to read ${path}:`, toLogValue(error));
    return undefined;
  }
  try {
    const parsed = JSON.parse(text);
    if (!isDynamicRecord(parsed) || parsed.version !== 1 || !isString(parsed.electron)) return undefined;
    return { electron: parsed.electron };
  } catch {
    return undefined;
  }
}

// Synchronous: the first write runs before the app is ready, and a crash can stop the process soon after.
function writeGpuFailure(path: string, electronVersion: string): void {
  try {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    writeFileSync(path, JSON.stringify({ version: 1, electron: electronVersion }));
  } catch (error) {
    logger.warn(`Unable to write ${path}:`, toLogValue(error));
  }
}

function removeFile(path: string): void {
  try {
    rmSync(path, { force: true });
  } catch (error) {
    logger.warn(`Unable to remove ${path}:`, toLogValue(error));
  }
}
