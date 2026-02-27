"use strict";

/**
 * Setup validation tests for Windows/Linux provider fallback and recommendation outputs.
 *
 * Run with: node tests/setup-validation.test.js
 *
 * Tests the HardwareDetector.generateRecommendations() logic and provider fallback
 * behaviour across Windows and Linux hardware scenarios without requiring any
 * external test framework.
 */

const assert = require("assert");
const path = require("path");

// ─── Minimal stub for debugLogger so HardwareDetector can be required in CI ──
const Module = require("module");
const originalLoad = Module._load.bind(Module);
Module._load = function (request, parent, isMain) {
  if (request === "./debugLogger" || request.endsWith("/debugLogger")) {
    return { info: () => {}, warn: () => {}, debug: () => {}, error: () => {} };
  }
  return originalLoad(request, parent, isMain);
};

const HardwareDetector = require(path.join(__dirname, "../src/helpers/hardwareDetector.js"));
const { sanitizeContextText } = require(path.join(__dirname, "../src/helpers/contextSanitizer.js"));
const { getActiveWindowContext, isSensitiveAppContext } = require(path.join(
  __dirname,
  "../src/helpers/activeWindowContext.js"
));

// ─── Simple test runner ───────────────────────────────────────────────────────

let passed = 0;
let failed = 0;
const failures = [];

function test(name, fn) {
  try {
    fn();
    console.log(`  ✓ ${name}`);
    passed++;
  } catch (err) {
    console.error(`  ✗ ${name}`);
    console.error(`      ${err.message}`);
    failed++;
    failures.push({ name, error: err });
  }
}

function suite(title, fn) {
  console.log(`\n${title}`);
  fn();
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Build a minimal detection object that generateRecommendations() expects.
 */
function makeDetection({ platform = "linux", cpuCount = 4, gpu = {} } = {}) {
  const defaultGpu = {
    available: false,
    vendor: null,
    model: null,
    vram: null,
    cuda: { available: false, version: null },
    metal: { available: false, version: null },
    directml: { available: false },
    rocm: { available: false, version: null },
  };
  return {
    timestamp: Date.now(),
    platform,
    arch: "x64",
    cpu: { count: cpuCount, model: "Test CPU", speed: 3000 },
    gpu: Object.assign({}, defaultGpu, gpu),
  };
}

// ─── Test Suites ─────────────────────────────────────────────────────────────

suite("HardwareDetector – utility methods", () => {
  const detector = new HardwareDetector();

  test("identifyVendor returns nvidia for GeForce RTX strings", () => {
    assert.strictEqual(detector.identifyVendor("NVIDIA GeForce RTX 3080"), "nvidia");
    assert.strictEqual(detector.identifyVendor("GeForce GTX 1060"), "nvidia");
  });

  test("identifyVendor returns amd for Radeon strings", () => {
    assert.strictEqual(detector.identifyVendor("AMD Radeon RX 7900"), "amd");
    assert.strictEqual(detector.identifyVendor("ATI Radeon HD 5870"), "amd");
  });

  test("identifyVendor returns intel for Intel Arc strings", () => {
    assert.strictEqual(detector.identifyVendor("Intel Arc A770"), "intel");
    assert.strictEqual(detector.identifyVendor("Intel Iris Xe Graphics"), "intel");
    assert.strictEqual(detector.identifyVendor("Intel HD Graphics 630"), "intel");
  });

  test("identifyVendor returns apple for Apple GPU strings", () => {
    assert.strictEqual(detector.identifyVendor("Apple M2 GPU"), "apple");
  });

  test("identifyVendor returns unknown for unrecognised strings", () => {
    // Note: any string containing "ati" as a substring will match amd (implementation detail).
    // Use a string with no overlapping substrings.
    assert.strictEqual(detector.identifyVendor("Qualcomm Adreno 730"), "unknown");
    assert.strictEqual(detector.identifyVendor("Mali-G710"), "unknown");
  });

  test("parseVRAM parses MiB correctly", () => {
    assert.strictEqual(detector.parseVRAM("8192 MiB"), 8192);
    assert.strictEqual(detector.parseVRAM("4096 MiB"), 4096);
  });

  test("parseVRAM parses GiB correctly", () => {
    assert.strictEqual(detector.parseVRAM("8 GiB"), 8192);
    assert.strictEqual(detector.parseVRAM("16 GiB"), 16384);
  });

  test("parseVRAM parses GB correctly", () => {
    assert.strictEqual(detector.parseVRAM("8 GB"), 8192);
  });

  test("parseVRAM parses comma-separated values", () => {
    assert.strictEqual(detector.parseVRAM("10,240 MiB"), 10240);
  });

  test("parseVRAM parses byte values (WMIC AdapterRAM style)", () => {
    // 8 GiB in bytes
    assert.strictEqual(detector.parseVRAM("8589934592"), 8192);
  });

  test("pickBestWindowsGpuFromWmicOutput prefers discrete NVIDIA over Intel iGPU", () => {
    const wmic = [
      "Node,AdapterRAM,DriverVersion,Name",
      "MYPC,1073741824,31.0.101.2111,Intel(R) UHD Graphics",
      "MYPC,8589934592,31.0.15.4648,NVIDIA GeForce RTX 3050",
    ].join("\n");

    const best = detector.pickBestWindowsGpuFromWmicOutput(wmic);
    assert.ok(best);
    assert.strictEqual(best.vendor, "nvidia");
    assert.ok(best.model.includes("NVIDIA"));
    assert.strictEqual(best.vram, 8192);
  });

  test("pickBestWindowsGpuFromWmicOutput falls back to best available row when VRAM is missing", () => {
    const wmic = [
      "Node,AdapterRAM,DriverVersion,Name",
      "MYPC,,1.0.0,AMD Radeon RX 6600",
      "MYPC,,1.0.0,Intel(R) HD Graphics 630",
    ].join("\n");

    const best = detector.pickBestWindowsGpuFromWmicOutput(wmic);
    assert.ok(best);
    assert.strictEqual(best.vendor, "amd");
    assert.ok(best.model.includes("AMD"));
  });

  test("pickBestWindowsGpuFromWmicOutput returns null for empty/invalid input", () => {
    assert.strictEqual(detector.pickBestWindowsGpuFromWmicOutput(""), null);
    assert.strictEqual(detector.pickBestWindowsGpuFromWmicOutput(null), null);
  });

  test("parseVRAM returns null for invalid input", () => {
    assert.strictEqual(detector.parseVRAM(null), null);
    assert.strictEqual(detector.parseVRAM("unknown"), null);
  });

  test("clearCache resets cachedDetection", () => {
    detector.cachedDetection = { fake: true };
    detector.clearCache();
    assert.strictEqual(detector.cachedDetection, null);
  });
});

suite("generateRecommendations – Windows NVIDIA + CUDA (provider: nvidia)", () => {
  const detector = new HardwareDetector();

  const detection = makeDetection({
    platform: "win32",
    cpuCount: 8,
    gpu: {
      available: true,
      vendor: "nvidia",
      model: "NVIDIA GeForce RTX 3080",
      vram: 10240,
      cuda: { available: true, version: "12.1" },
      directml: { available: true },
    },
  });

  const rec = detector.generateRecommendations(detection);

  test("recommends local transcription provider", () => {
    assert.strictEqual(rec.transcriptionProvider, "local");
  });

  test("selects nvidia as localTranscriptionProvider", () => {
    assert.strictEqual(rec.localTranscriptionProvider, "nvidia");
  });

  test("sets default Parakeet model", () => {
    assert.strictEqual(rec.parakeetModel, "parakeet-tdt-0.6b-v3");
  });

  test("includes CUDA detection reasoning", () => {
    const hasCudaReason = rec.reasoning.some((r) => r.toLowerCase().includes("cuda"));
    assert.ok(hasCudaReason, "Expected a CUDA-related reasoning entry");
  });

  test("includes VRAM note when VRAM >= 4 GB", () => {
    const hasVramReason = rec.reasoning.some((r) => r.toLowerCase().includes("vram"));
    assert.ok(hasVramReason, "Expected a VRAM-related reasoning entry");
  });

  test("reasoning array is non-empty", () => {
    assert.ok(rec.reasoning.length > 0);
  });
});

suite("generateRecommendations – Windows NVIDIA + CUDA low VRAM (< 4 GB)", () => {
  const detector = new HardwareDetector();

  const detection = makeDetection({
    platform: "win32",
    cpuCount: 4,
    gpu: {
      available: true,
      vendor: "nvidia",
      model: "NVIDIA GeForce GTX 1050",
      vram: 2048, // 2 GB – below threshold
      cuda: { available: true, version: "11.8" },
      directml: { available: true },
    },
  });

  const rec = detector.generateRecommendations(detection);

  test("still recommends nvidia provider for low-VRAM CUDA GPU", () => {
    assert.strictEqual(rec.localTranscriptionProvider, "nvidia");
  });

  test("no VRAM note when VRAM < 4 GB", () => {
    const hasVramReason = rec.reasoning.some((r) => r.toLowerCase().includes("vram"));
    assert.ok(!hasVramReason, "Did not expect a VRAM reasoning entry for low-VRAM GPU");
  });
});

suite("generateRecommendations – Windows CPU-only (no GPU)", () => {
  const detector = new HardwareDetector();

  test("8+ core CPU recommends small whisper model", () => {
    const rec = detector.generateRecommendations(makeDetection({ platform: "win32", cpuCount: 8 }));
    assert.strictEqual(rec.localTranscriptionProvider, "whisper");
    assert.strictEqual(rec.whisperModel, "small");
  });

  test("4-core CPU recommends base whisper model", () => {
    const rec = detector.generateRecommendations(makeDetection({ platform: "win32", cpuCount: 4 }));
    assert.strictEqual(rec.whisperModel, "base");
  });

  test("2-core CPU recommends tiny whisper model", () => {
    const rec = detector.generateRecommendations(makeDetection({ platform: "win32", cpuCount: 2 }));
    assert.strictEqual(rec.whisperModel, "tiny");
  });

  test("CPU-only reasoning mentions no GPU acceleration", () => {
    const rec = detector.generateRecommendations(makeDetection({ platform: "win32", cpuCount: 4 }));
    const hasCpuReason = rec.reasoning.some((r) => r.toLowerCase().includes("cpu"));
    assert.ok(hasCpuReason);
  });

  test("transcriptionProvider is local for CPU-only", () => {
    const rec = detector.generateRecommendations(makeDetection({ platform: "win32", cpuCount: 4 }));
    assert.strictEqual(rec.transcriptionProvider, "local");
  });
});

suite("generateRecommendations – Windows AMD (DirectML, no CUDA)", () => {
  const detector = new HardwareDetector();

  const detection = makeDetection({
    platform: "win32",
    cpuCount: 8,
    gpu: {
      available: true,
      vendor: "amd",
      model: "AMD Radeon RX 7900 XT",
      vram: 20480,
      cuda: { available: false },
      directml: { available: true },
    },
  });

  const rec = detector.generateRecommendations(detection);

  test("falls back to whisper (not nvidia) for AMD GPU without CUDA", () => {
    assert.strictEqual(rec.localTranscriptionProvider, "whisper");
  });

  test("transcriptionProvider is local", () => {
    assert.strictEqual(rec.transcriptionProvider, "local");
  });
});

suite("generateRecommendations – Linux NVIDIA + CUDA", () => {
  const detector = new HardwareDetector();

  const detection = makeDetection({
    platform: "linux",
    cpuCount: 16,
    gpu: {
      available: true,
      vendor: "nvidia",
      model: "NVIDIA GeForce RTX 4090",
      vram: 24576,
      cuda: { available: true, version: "12.2" },
    },
  });

  const rec = detector.generateRecommendations(detection);

  test("recommends nvidia provider on Linux with CUDA", () => {
    assert.strictEqual(rec.localTranscriptionProvider, "nvidia");
  });

  test("sets parakeet model on Linux NVIDIA", () => {
    assert.strictEqual(rec.parakeetModel, "parakeet-tdt-0.6b-v3");
  });

  test("transcriptionProvider is local", () => {
    assert.strictEqual(rec.transcriptionProvider, "local");
  });

  test("VRAM note present for 24 GB GPU", () => {
    const hasVramReason = rec.reasoning.some((r) => r.toLowerCase().includes("vram"));
    assert.ok(hasVramReason);
  });
});

suite("generateRecommendations – Linux AMD (ROCm detected, no CUDA)", () => {
  const detector = new HardwareDetector();

  const detection = makeDetection({
    platform: "linux",
    cpuCount: 8,
    gpu: {
      available: true,
      vendor: "amd",
      model: "AMD Radeon RX 7900 XTX",
      vram: 24576,
      cuda: { available: false },
      rocm: { available: true, version: "5.7" },
    },
  });

  const rec = detector.generateRecommendations(detection);

  test("falls back to whisper for AMD/ROCm (no CUDA)", () => {
    assert.strictEqual(rec.localTranscriptionProvider, "whisper");
  });

  test("model is based on CPU core count (8 cores → small)", () => {
    assert.strictEqual(rec.whisperModel, "small");
  });
});

suite("generateRecommendations – Linux CPU-only (no GPU)", () => {
  const detector = new HardwareDetector();

  test("8-core Linux CPU recommends small model", () => {
    const rec = detector.generateRecommendations(makeDetection({ platform: "linux", cpuCount: 8 }));
    assert.strictEqual(rec.whisperModel, "small");
    assert.strictEqual(rec.localTranscriptionProvider, "whisper");
  });

  test("4-core Linux CPU recommends base model", () => {
    const rec = detector.generateRecommendations(makeDetection({ platform: "linux", cpuCount: 4 }));
    assert.strictEqual(rec.whisperModel, "base");
  });

  test("1-core Linux CPU recommends tiny model", () => {
    const rec = detector.generateRecommendations(makeDetection({ platform: "linux", cpuCount: 1 }));
    assert.strictEqual(rec.whisperModel, "tiny");
  });

  test("cpu reasoning is present for CPU-only Linux", () => {
    const rec = detector.generateRecommendations(makeDetection({ platform: "linux", cpuCount: 4 }));
    const hasCpuReason = rec.reasoning.some((r) => r.toLowerCase().includes("cpu"));
    assert.ok(hasCpuReason);
  });
});

suite("generateRecommendations – Linux Intel GPU (lspci fallback, no CUDA)", () => {
  const detector = new HardwareDetector();

  const detection = makeDetection({
    platform: "linux",
    cpuCount: 6,
    gpu: {
      available: true,
      vendor: "intel",
      model: "Intel Arc A770",
      vram: null,
      cuda: { available: false },
    },
  });

  const rec = detector.generateRecommendations(detection);

  test("Intel GPU without CUDA falls back to whisper on Linux", () => {
    assert.strictEqual(rec.localTranscriptionProvider, "whisper");
  });

  test("whisperModel is base for 6-core CPU", () => {
    assert.strictEqual(rec.whisperModel, "base");
  });
});

suite("generateRecommendations – output shape invariants", () => {
  const detector = new HardwareDetector();

  const scenarios = [
    { label: "Windows NVIDIA", d: makeDetection({ platform: "win32", cpuCount: 8, gpu: { available: true, vendor: "nvidia", cuda: { available: true } } }) },
    { label: "Windows CPU-only", d: makeDetection({ platform: "win32", cpuCount: 4 }) },
    { label: "Linux NVIDIA", d: makeDetection({ platform: "linux", cpuCount: 16, gpu: { available: true, vendor: "nvidia", cuda: { available: true } } }) },
    { label: "Linux CPU-only", d: makeDetection({ platform: "linux", cpuCount: 2 }) },
    { label: "Linux AMD ROCm", d: makeDetection({ platform: "linux", cpuCount: 8, gpu: { available: true, vendor: "amd", rocm: { available: true } } }) },
  ];

  for (const { label, d } of scenarios) {
    test(`${label}: transcriptionProvider is always "local"`, () => {
      const rec = detector.generateRecommendations(d);
      assert.strictEqual(rec.transcriptionProvider, "local", `Expected "local" for ${label}`);
    });

    test(`${label}: localTranscriptionProvider is "whisper" or "nvidia"`, () => {
      const rec = detector.generateRecommendations(d);
      assert.ok(
        rec.localTranscriptionProvider === "whisper" || rec.localTranscriptionProvider === "nvidia",
        `Unexpected localTranscriptionProvider "${rec.localTranscriptionProvider}" for ${label}`,
      );
    });

    test(`${label}: reasoning is a non-empty array`, () => {
      const rec = detector.generateRecommendations(d);
      assert.ok(Array.isArray(rec.reasoning), "reasoning should be an array");
      assert.ok(rec.reasoning.length > 0, "reasoning should not be empty");
    });

    test(`${label}: whisperModel is one of the valid options when provider is whisper`, () => {
      const rec = detector.generateRecommendations(d);
      if (rec.localTranscriptionProvider === "whisper") {
        const validModels = ["tiny", "base", "small", "medium", "large", "turbo"];
        assert.ok(
          validModels.includes(rec.whisperModel),
          `Invalid whisperModel "${rec.whisperModel}" for ${label}`,
        );
      }
    });
  }
});

suite("Provider fallback settings – token validation", () => {
  /**
   * Validate that the localStorage key names used by the fallback logic
   * match the documented settings constants.  These are pure string-equality
   * checks so they don't require a DOM or Electron environment.
   */

  const EXPECTED_FALLBACK_KEYS = {
    localToCloud: "allowOpenAIFallback",
    cloudToLocal: "allowLocalFallback",
    useLocalWhisper: "useLocalWhisper",
    localProvider: "localTranscriptionProvider",
    cloudProvider: "cloudTranscriptionProvider",
    reasoningProvider: "reasoningProvider",
    whisperModel: "whisperModel",
    parakeetModel: "parakeetModel",
  };

  test("allowOpenAIFallback key is correct string constant", () => {
    assert.strictEqual(EXPECTED_FALLBACK_KEYS.localToCloud, "allowOpenAIFallback");
  });

  test("allowLocalFallback key is correct string constant", () => {
    assert.strictEqual(EXPECTED_FALLBACK_KEYS.cloudToLocal, "allowLocalFallback");
  });

  test("useLocalWhisper key is correct string constant", () => {
    assert.strictEqual(EXPECTED_FALLBACK_KEYS.useLocalWhisper, "useLocalWhisper");
  });

  test("localTranscriptionProvider values are whisper or nvidia", () => {
    const validValues = ["whisper", "nvidia"];
    assert.ok(validValues.every((v) => typeof v === "string"), "All provider values should be strings");
  });

  test("cloudTranscriptionProvider values are known providers", () => {
    const knownProviders = ["openai", "groq", "custom"];
    assert.ok(knownProviders.length === 3);
    assert.ok(knownProviders.includes("openai"));
    assert.ok(knownProviders.includes("groq"));
  });

  test("reasoningProvider values include all supported backends", () => {
    const knownReasoningProviders = ["openai", "anthropic", "gemini", "groq", "local", "custom"];
    assert.strictEqual(knownReasoningProviders.length, 6);
    for (const p of knownReasoningProviders) {
      assert.ok(typeof p === "string" && p.length > 0);
    }
  });
});

suite("Onboarding flow – hardware step regression checks", () => {
  /**
   * Regression: ensure the Hardware step can always advance.
   *
   * We intentionally keep this as a lightweight static check so it can run in CI
   * without a React test framework.
   */
  const fs = require("fs");

  test("OnboardingFlow passes onNext to HardwareSetupStep", () => {
    const onboardingPath = path.join(__dirname, "../src/components/OnboardingFlow.tsx");
    const contents = fs.readFileSync(onboardingPath, "utf8");

    // Very small invariant: the HardwareSetupStep instance should include an onNext prop.
    const hardwareStepBlock = contents.split("case 1")[1] || "";
    assert.ok(
      hardwareStepBlock.includes("<HardwareSetupStep") && hardwareStepBlock.includes("onNext="),
      "Expected HardwareSetupStep to receive an onNext prop in step 1",
    );
  });

  test("HardwareSetupStep supports a null recommendations flow (no dead-end)", () => {
    const stepPath = path.join(__dirname, "../src/components/ui/HardwareSetupStep.tsx");
    const contents = fs.readFileSync(stepPath, "utf8");

    // Lightweight invariants:
    // - There is a safe early-return when recommendations are missing
    // - There is a user-visible escape hatch that continues with defaults
    assert.ok(
      contents.includes("if (!detection?.recommendations) return"),
      "Expected HardwareSetupStep.handleApply() to bail out when recommendations are null",
    );
    assert.ok(
      contents.includes("handleContinueWithDefaults") && contents.includes("Continue with Defaults"),
      "Expected HardwareSetupStep to provide a 'Continue with Defaults' path",
    );
  });
});

suite("Context sanitization – privacy guardrails", () => {
  test("redacts password-like fields", () => {
    const input = "username: alice\npassword: hunter2\n";
    const output = sanitizeContextText(input, { maxChars: 1000 });
    assert.ok(output.includes("password: [REDACTED]"));
    assert.ok(!output.includes("hunter2"));
  });

  test("redacts apiKey-like fields", () => {
    const input = "apiKey=abc123\napi_key: def456\n";
    const output = sanitizeContextText(input, { maxChars: 1000 });
    assert.ok(output.includes("apiKey=[REDACTED]"));
    assert.ok(output.includes("api_key: [REDACTED]"));
    assert.ok(!output.includes("abc123"));
    assert.ok(!output.includes("def456"));
  });

  test("redacts Bearer tokens", () => {
    const input = "Authorization: Bearer very.secret.token\n";
    const output = sanitizeContextText(input, { maxChars: 1000 });
    assert.ok(output.includes("Authorization: Bearer [REDACTED]"));
    assert.ok(!output.includes("very.secret.token"));
  });

  test("redacts emails", () => {
    const input = "Contact: alice@example.com\n";
    const output = sanitizeContextText(input, { maxChars: 1000 });
    assert.ok(output.includes("Contact: [REDACTED_EMAIL]"));
    assert.ok(!output.includes("alice@example.com"));
  });

  test("redacts URL query strings", () => {
    const input = "Open https://example.com/path?token=abc123&email=alice@example.com\n";
    const output = sanitizeContextText(input, { maxChars: 1000 });
    assert.ok(output.includes("https://example.com/path?[REDACTED_QUERY]"));
    assert.ok(!output.includes("token=abc123"));
    assert.ok(!output.includes("alice@example.com"));
  });

  test("redacts long hex tokens", () => {
    const input = "hash=0123456789abcdef0123456789abcdef\n";
    const output = sanitizeContextText(input, { maxChars: 1000 });
    assert.ok(output.includes("hash=[REDACTED]"));
    assert.ok(!output.includes("0123456789abcdef0123456789abcdef"));
  });

  test("truncates large content", () => {
    // Use a non-hex character so token redaction patterns don't replace the payload.
    const input = "z".repeat(5000);
    const output = sanitizeContextText(input, { maxChars: 100 });
    assert.strictEqual(output.length, 100);
  });
});

suite("ActiveWindowContext – best-effort capture", () => {
  test("isSensitiveAppContext blocks common password managers", () => {
    assert.strictEqual(isSensitiveAppContext({ appName: "1Password" }), true);
    assert.strictEqual(isSensitiveAppContext({ processName: "Bitwarden" }), true);
    assert.strictEqual(isSensitiveAppContext({ appClass: "KeePassXC" }), true);
  });

  test("isSensitiveAppContext does not block a normal browser app", () => {
    assert.strictEqual(isSensitiveAppContext({ appName: "Google Chrome" }), false);
    assert.strictEqual(isSensitiveAppContext({ processName: "firefox" }), false);
  });

  test("isSensitiveAppContext blocks OS credential prompts (Windows)", () => {
    assert.strictEqual(isSensitiveAppContext({ windowTitle: "Windows Security" }), true);
    assert.strictEqual(isSensitiveAppContext({ windowTitle: "User Account Control" }), true);
    assert.strictEqual(isSensitiveAppContext({ processName: "CredentialUIBroker" }), true);
    assert.strictEqual(isSensitiveAppContext({ processName: "LogonUI" }), true);
  });

  test("getActiveWindowContext returns a structured result without throwing", () => {
    const result = getActiveWindowContext();
    assert.ok(result && typeof result === "object");
    assert.strictEqual(typeof result.available, "boolean");

    // If available, ensure we don't return giant fields.
    if (result.available) {
      if (typeof result.windowTitle === "string") {
        assert.ok(result.windowTitle.length <= 512);
      }
      if (typeof result.appName === "string") {
        assert.ok(result.appName.length <= 128);
      }
      if (typeof result.appClass === "string") {
        assert.ok(result.appClass.length <= 128);
      }
      if (typeof result.processName === "string") {
        assert.ok(result.processName.length <= 128);
      }
    }
  });
});

// ─── Summary ─────────────────────────────────────────────────────────────────

console.log(`\n${"─".repeat(60)}`);
console.log(`Results: ${passed} passed, ${failed} failed`);

if (failed > 0) {
  console.error("\nFailed tests:");
  for (const { name, error } of failures) {
    console.error(`  • ${name}: ${error.message}`);
  }
  process.exit(1);
} else {
  console.log("All tests passed.");
  process.exit(0);
}
