import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import vm from "node:vm";
import { createRequire } from "node:module";
import { finished } from "node:stream/promises";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The log file exists only for debug logging. Turning the switch off lowered
 * the level but left the file open, so every info, warning and error line kept
 * landing in it until the app restarted. Some of those lines carry dictated
 * text, such as the transcript the app dropped as non-speech.
 */

const filename = path.resolve("src/helpers/debugLogger.js");
const requireHelper = createRequire(filename);
const userData = { dir: "" };

// The logger is CommonJS and takes `app` from electron when it loads, which
// vi.mock cannot replace. Load the real file with an electron that is ready.
function loadDebugLogger() {
  const module = { exports: undefined as any };
  vm.runInNewContext(fs.readFileSync(filename, "utf8"), {
    module,
    process,
    console,
    Date,
    require: (name: string) => {
      if (name === "electron") {
        return {
          app: { isReady: () => true, getPath: () => userData.dir, getAppPath: () => "/app" },
        };
      }
      return requireHelper(name);
    },
  });
  return module.exports;
}

async function readLog(logPath: string, stream: fs.WriteStream) {
  stream.end();
  await finished(stream);
  return fs.readFileSync(logPath, "utf8");
}

describe("debug log file when debug logging is switched", () => {
  beforeEach(() => {
    userData.dir = fs.mkdtempSync(path.join(os.tmpdir(), "pt-debug-logger-"));
    vi.stubEnv("LOG_LEVEL", "");
    vi.stubEnv("PT_LOG_LEVEL", "debug");
    vi.spyOn(console, "log").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    fs.rmSync(userData.dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  });

  it("stops writing to the file once debug logging is turned off", async () => {
    const logger = loadDebugLogger();
    logger.ensureFileLogging();
    const logPath = logger.getLogPath();
    const stream = logger.logStream;
    expect(logPath).toContain(userData.dir);

    vi.stubEnv("PT_LOG_LEVEL", "info");
    logger.refreshLogLevel();
    logger.info("Dropped a non-speech transcript", { text: "words the user dictated" });

    expect(await readLog(logPath, stream)).not.toContain("words the user dictated");
    expect(logger.isEnabled()).toBe(false);
    expect(logger.getLogPath()).toBeNull();
  });

  it("writes to a log file again when debug logging is turned back on", async () => {
    const logger = loadDebugLogger();
    logger.ensureFileLogging();
    const firstPath = logger.getLogPath();
    const firstStream = logger.logStream;
    vi.stubEnv("PT_LOG_LEVEL", "info");
    logger.refreshLogLevel();
    await finished(firstStream);
    // Log files are named by the millisecond they were opened in.
    await new Promise((resolve) => setTimeout(resolve, 5));

    vi.stubEnv("PT_LOG_LEVEL", "debug");
    logger.refreshLogLevel();
    logger.debug("a line for the support log");

    const logPath = logger.getLogPath();
    expect(logPath).toContain(userData.dir);
    expect(logPath).not.toBe(firstPath);
    expect(await readLog(logPath, logger.logStream)).toContain("a line for the support log");
    expect(fs.readFileSync(firstPath, "utf8")).not.toContain("a line for the support log");
  });
});
