import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The pause/skip keys are the only shortcuts in the app that are supposed to
 * come and go. What matters is therefore not that they can be registered, but
 * that they are released again — a read that ends while
 * Ctrl+Alt+Shift+Space is still bound would quietly take the combination from
 * every other app on the machine forever.
 *
 * Dependencies are injected rather than vi.mock'd: `require("electron")` inside
 * src/helpers is CommonJS and vitest cannot replace it (outside Electron it
 * resolves to the npm package's binary path), which is why hotkeyManager's own
 * test can only assert on decisions and never on registration. Handing the
 * helper a fake globalShortcut is what makes the registration itself provable.
 */

const ACCELERATORS = ["Ctrl+Alt+Shift+Space", "Ctrl+Alt+Shift+Left", "Ctrl+Alt+Shift+Right"];

let register: ReturnType<typeof vi.fn>;
let unregister: ReturnType<typeof vi.fn>;
let warn: ReturnType<typeof vi.fn>;
let logger: { warn: typeof warn; error: ReturnType<typeof vi.fn> };

async function loadPlaybackKeys() {
  const mod: any = await import("../../../src/helpers/readAloudPlaybackKeys.js");
  return mod.default ?? mod;
}

function makeDeps() {
  register = vi.fn(() => true);
  unregister = vi.fn();
  warn = vi.fn();
  logger = { warn, error: vi.fn() };
  return { shortcuts: { register, unregister }, logger };
}

describe("ReadAloudPlaybackKeys", () => {
  beforeEach(() => {
    delete process.env.PRIVATETRANSCRIBE_DIAG_DISABLE_GLOBAL_SHORTCUT;
  });

  afterEach(() => {
    delete process.env.PRIVATETRANSCRIBE_DIAG_DISABLE_GLOBAL_SHORTCUT;
  });

  it("registers exactly the three playback accelerators when a read starts", async () => {
    const ReadAloudPlaybackKeys = await loadPlaybackKeys();
    const keys = new ReadAloudPlaybackKeys(() => {}, makeDeps());

    const result = keys.apply({ active: true });

    expect(register).toHaveBeenCalledTimes(3);
    expect(register.mock.calls.map((call) => call[0])).toEqual(ACCELERATORS);
    expect(result.active).toBe(true);
    expect(result.registered).toEqual(ACCELERATORS);
  });

  it("is idempotent - a second apply while already active registers nothing extra", async () => {
    const ReadAloudPlaybackKeys = await loadPlaybackKeys();
    const keys = new ReadAloudPlaybackKeys(() => {}, makeDeps());

    keys.apply({ active: true });
    register.mockClear();

    const result = keys.apply({ active: true });

    expect(register).not.toHaveBeenCalled();
    expect(result.registered).toEqual(ACCELERATORS);
  });

  it("releases all three when the read ends", async () => {
    const ReadAloudPlaybackKeys = await loadPlaybackKeys();
    const keys = new ReadAloudPlaybackKeys(() => {}, makeDeps());

    keys.apply({ active: true });
    const result = keys.apply({ active: false });

    expect(unregister.mock.calls.map((call) => call[0])).toEqual(ACCELERATORS);
    expect(result.active).toBe(false);
    expect(keys.getStatus()).toEqual({ active: false, registered: [] });
  });

  it("never binds a machine-global key when the diagnostic flag is set", async () => {
    process.env.PRIVATETRANSCRIBE_DIAG_DISABLE_GLOBAL_SHORTCUT = "1";
    const ReadAloudPlaybackKeys = await loadPlaybackKeys();
    const keys = new ReadAloudPlaybackKeys(() => {}, makeDeps());

    const result = keys.apply({ active: true });

    expect(register).not.toHaveBeenCalled();
    expect(result).toEqual({ active: false, registered: [], reason: "diagnostic-flag" });
    expect(warn).toHaveBeenCalled();
  });

  it("swallows a registration throw and keeps the keys that did bind", async () => {
    const ReadAloudPlaybackKeys = await loadPlaybackKeys();
    const deps = makeDeps();
    register.mockImplementation((accelerator: string) => {
      if (accelerator === "Ctrl+Alt+Shift+Left") throw new Error("taken by the OS");
      return true;
    });
    const keys = new ReadAloudPlaybackKeys(() => {}, deps);

    const result = keys.apply({ active: true });

    expect(result.active).toBe(true);
    expect(result.registered).toEqual(["Ctrl+Alt+Shift+Space", "Ctrl+Alt+Shift+Right"]);
    expect(warn).toHaveBeenCalledWith(
      '[ReadAloud] Playback key "Ctrl+Alt+Shift+Left" failed to register',
      { error: "taken by the OS" }
    );
  });

  it("forwards a press as an op to the overlay callback", async () => {
    const ReadAloudPlaybackKeys = await loadPlaybackKeys();
    const onControl = vi.fn();
    const keys = new ReadAloudPlaybackKeys(onControl, makeDeps());

    keys.apply({ active: true });

    // Fire each accelerator's registered handler.
    for (const call of register.mock.calls) (call[1] as () => void)();

    expect(onControl.mock.calls.map((call) => call[0])).toEqual(["toggle", "back", "forward"]);
  });
});
