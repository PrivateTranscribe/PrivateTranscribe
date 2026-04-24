import { describe, it, expect, vi, beforeAll, beforeEach } from "vitest";

/**
 * Platform-specific hardware detection regression tests.
 *
 * Two complementary testing strategies:
 *
 * 1. **generateRecommendations() with synthetic detection objects** — directly
 *    exercises the recommendation logic using the GPU/CPU state that each OS
 *    detection path would produce. No OS calls needed.
 *
 * 2. **detectWindowsGPU / detectLinuxGPU with CJS execSync spy** — uses CJS
 *    require to get a mutable reference to child_process (ESM namespace is
 *    non-configurable), spies on execSync, and reloads the module fresh so the
 *    module's top-level destructure captures the spy.
 *
 * 3. **pickBestWindowsGpuFromWmicOutput** — pure function, no mocking required.
 */

// ── Module mocks ──────────────────────────────────────────────────────────────

vi.mock("../../../src/helpers/debugLogger", () => ({
  default: { info: vi.fn(), warn: vi.fn(), debug: vi.fn() },
  info: vi.fn(),
  warn: vi.fn(),
  debug: vi.fn(),
}));

// ── CJS references (for execSync spy — ESM namespace is non-configurable) ────

// eslint-disable-next-line @typescript-eslint/no-require-imports
const childProcessCJS = require("child_process") as {
  execSync: (...args: unknown[]) => unknown;
};

// ── Spy setup and fresh module load ───────────────────────────────────────────
//
// vi.spyOn on the CJS module object works because CJS exports are plain objects
// (unlike the read-only ESM Module Namespace Objects).
// We reload hardwareDetector.js in beforeAll so its `const { execSync } = require("child_process")`
// captures the spy function rather than the original.

let execSyncSpy: ReturnType<typeof vi.spyOn>;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let HardwareDetector: { new (): any };

beforeAll(() => {
  execSyncSpy = vi.spyOn(childProcessCJS, "execSync");
  vi.resetModules();
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  HardwareDetector = require("../../../src/helpers/hardwareDetector");
});

beforeEach(() => {
  // The global afterEach in tests/setup.ts calls vi.restoreAllMocks(), which
  // resets the spy to call through to the original. Re-configure here so no
  // real OS commands are invoked during tests.
  execSyncSpy.mockImplementation(() => {
    throw new Error("execSync: not configured for this test");
  });
});

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeGpu() {
  return {
    available: false,
    vendor: null as string | null,
    model: null as string | null,
    vram: null as number | null,
    cuda: { available: false, version: null as string | null },
    metal: { available: false, version: null as string | null },
    directml: { available: false },
    rocm: { available: false, version: null as string | null },
  };
}

const WMIC_NVIDIA_ONLY =
  "Node,AdapterRAM,DriverVersion,Name\n" +
  "MYPC,4294967296,30.0.15.1179,NVIDIA GeForce GTX 1050";

const WMIC_MULTI_GPU =
  "Node,AdapterRAM,DriverVersion,Name\n" +
  "MYPC,4294967296,10.18.15.4279,Intel(R) UHD Graphics 630\n" +
  "MYPC,8589934592,31.0.15.4672,NVIDIA GeForce RTX 3080";

const WMIC_AMD_ONLY =
  "Node,AdapterRAM,DriverVersion,Name\n" +
  "MYPC,8589934592,27.20.14501.18003,AMD Radeon RX 6800";

const NVIDIA_SMI_RTX = "NVIDIA GeForce RTX 3080, 10240 MiB, 525.89.02";

const LSPCI_NVIDIA =
  "01:00.0 VGA compatible controller: NVIDIA Corporation GeForce RTX 3060 (rev a1)";

const LSPCI_AMD =
  "01:00.0 VGA compatible controller: Advanced Micro Devices, Inc. [AMD/ATI] Radeon RX 6800";

const notFound = () => {
  throw new Error("command not found");
};

// ── Platform spy helper ───────────────────────────────────────────────────────

let platformSpy: ReturnType<typeof vi.spyOn> | null = null;

function mockPlatform(platform: NodeJS.Platform) {
  platformSpy?.mockRestore();
  platformSpy = vi.spyOn(process, "platform", "get").mockReturnValue(platform);
}

// ─────────────────────────────────────────────────────────────────────────────
// detectWindowsGPU — CUDA missing (nvidia-smi absent)
// ─────────────────────────────────────────────────────────────────────────────

describe("detectWindowsGPU — WMIC detects NVIDIA, nvidia-smi absent", () => {
  it("sets vendor=nvidia and available=true from WMIC output", async () => {
    execSyncSpy
      .mockReturnValueOnce(WMIC_NVIDIA_ONLY)
      .mockImplementationOnce(notFound);

    const gpu = makeGpu();
    await new HardwareDetector().detectWindowsGPU(gpu);

    expect(gpu.vendor).toBe("nvidia");
    expect(gpu.available).toBe(true);
  });

  it("leaves cuda.available=false when nvidia-smi is absent", async () => {
    execSyncSpy
      .mockReturnValueOnce(WMIC_NVIDIA_ONLY)
      .mockImplementationOnce(notFound);

    const gpu = makeGpu();
    await new HardwareDetector().detectWindowsGPU(gpu);

    expect(gpu.cuda.available).toBe(false);
  });

  it("selects the NVIDIA dGPU over the Intel iGPU in multi-GPU WMIC output", async () => {
    execSyncSpy
      .mockReturnValueOnce(WMIC_MULTI_GPU)
      .mockImplementationOnce(notFound);

    const gpu = makeGpu();
    await new HardwareDetector().detectWindowsGPU(gpu);

    expect(gpu.vendor).toBe("nvidia");
    expect(gpu.model).toContain("RTX 3080");
  });

  it("correctly identifies AMD GPU from WMIC when no NVIDIA present", async () => {
    execSyncSpy
      .mockReturnValueOnce(WMIC_AMD_ONLY)
      .mockImplementationOnce(notFound);

    const gpu = makeGpu();
    await new HardwareDetector().detectWindowsGPU(gpu);

    expect(gpu.vendor).toBe("amd");
    expect(gpu.available).toBe(true);
  });
});

describe("detectWindowsGPU — nvidia-smi present (CUDA confirmed)", () => {
  it("marks cuda.available=true when nvidia-smi succeeds", async () => {
    execSyncSpy
      .mockReturnValueOnce(WMIC_NVIDIA_ONLY)
      .mockReturnValueOnce(NVIDIA_SMI_RTX);

    const gpu = makeGpu();
    await new HardwareDetector().detectWindowsGPU(gpu);

    expect(gpu.cuda.available).toBe(true);
    expect(gpu.vendor).toBe("nvidia");
  });

  it("captures VRAM from nvidia-smi output", async () => {
    execSyncSpy
      .mockReturnValueOnce(WMIC_NVIDIA_ONLY)
      .mockReturnValueOnce(NVIDIA_SMI_RTX); // "10240 MiB"

    const gpu = makeGpu();
    await new HardwareDetector().detectWindowsGPU(gpu);

    expect(gpu.vram).toBe(10240);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// detectLinuxGPU — all tools absent
// ─────────────────────────────────────────────────────────────────────────────

describe("detectLinuxGPU — all GPU detection tools absent (nvidia-smi, rocm-smi, lspci)", () => {
  beforeEach(() => {
    execSyncSpy.mockImplementation(notFound);
  });

  it("leaves gpu.available=false", async () => {
    const gpu = makeGpu();
    await new HardwareDetector().detectLinuxGPU(gpu);
    expect(gpu.available).toBe(false);
  });

  it("leaves vendor=null", async () => {
    const gpu = makeGpu();
    await new HardwareDetector().detectLinuxGPU(gpu);
    expect(gpu.vendor).toBeNull();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// detectLinuxGPU — lspci fallback
// ─────────────────────────────────────────────────────────────────────────────

describe("detectLinuxGPU — lspci fallback when nvidia-smi and rocm-smi are absent", () => {
  function stubLspciOnly(lspciOutput: string) {
    execSyncSpy
      .mockImplementationOnce(notFound) // nvidia-smi
      .mockImplementationOnce(notFound) // rocm-smi
      .mockReturnValueOnce(lspciOutput); // lspci
  }

  it("detects NVIDIA vendor from lspci output", async () => {
    stubLspciOnly(LSPCI_NVIDIA);
    const gpu = makeGpu();
    await new HardwareDetector().detectLinuxGPU(gpu);
    expect(gpu.vendor).toBe("nvidia");
    expect(gpu.available).toBe(true);
  });

  it("leaves cuda.available=false when NVIDIA detected only via lspci", async () => {
    stubLspciOnly(LSPCI_NVIDIA);
    const gpu = makeGpu();
    await new HardwareDetector().detectLinuxGPU(gpu);
    expect(gpu.cuda.available).toBe(false);
  });

  it("detects AMD vendor from lspci output", async () => {
    stubLspciOnly(LSPCI_AMD);
    const gpu = makeGpu();
    await new HardwareDetector().detectLinuxGPU(gpu);
    expect(gpu.vendor).toBe("amd");
    expect(gpu.available).toBe(true);
  });
});

describe("detectLinuxGPU — nvidia-smi present", () => {
  it("marks cuda.available=true when nvidia-smi succeeds", async () => {
    execSyncSpy
      .mockReturnValueOnce(NVIDIA_SMI_RTX)
      .mockImplementationOnce(notFound); // nvcc optional

    const gpu = makeGpu();
    await new HardwareDetector().detectLinuxGPU(gpu);

    expect(gpu.cuda.available).toBe(true);
    expect(gpu.vendor).toBe("nvidia");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// generateRecommendations — Windows scenarios
// ─────────────────────────────────────────────────────────────────────────────

describe("generateRecommendations — Windows: NVIDIA GPU, CUDA absent", () => {
  function windowsNvidiaNoCuda(cpuCount = 8) {
    return {
      gpu: {
        available: true,
        vendor: "nvidia",
        model: "NVIDIA GeForce GTX 1050",
        vram: 4096,
        cuda: { available: false, version: null },
        metal: { available: false, version: null },
      },
      cpu: { count: cpuCount },
    };
  }

  beforeEach(() => mockPlatform("win32"));

  it("produces nvidia_no_cuda category", () => {
    expect(new HardwareDetector().generateRecommendations(windowsNvidiaNoCuda()).gpuCategory).toBe(
      "nvidia_no_cuda"
    );
  });

  it("falls back to whisper — does NOT recommend Parakeet", () => {
    const rec = new HardwareDetector().generateRecommendations(windowsNvidiaNoCuda());
    expect(rec.localTranscriptionProvider).toBe("whisper");
    expect(rec.parakeetModel).toBeUndefined();
  });

  it("provides non-empty recovery steps", () => {
    const rec = new HardwareDetector().generateRecommendations(windowsNvidiaNoCuda());
    expect((rec.recoverySteps as string[]).length).toBeGreaterThan(0);
  });

  it("Windows recovery steps reference nvidia.com/drivers — not Linux package managers", () => {
    const rec = new HardwareDetector().generateRecommendations(windowsNvidiaNoCuda());
    const combined = (rec.recoverySteps as string[]).join(" ");
    expect(combined).toMatch(/nvidia\.com/i);
    expect(combined).not.toMatch(/\bapt\b/);
    expect(combined).not.toMatch(/\bdnf\b/);
    expect(combined).not.toMatch(/\bpacman\b/);
  });

  it("recommends turbo for an 8-core CPU (no GPU acceleration path)", () => {
    expect(
      new HardwareDetector().generateRecommendations(windowsNvidiaNoCuda(8)).whisperModel
    ).toBe("turbo");
  });

  it("recommends base for a 4-core CPU", () => {
    expect(
      new HardwareDetector().generateRecommendations(windowsNvidiaNoCuda(4)).whisperModel
    ).toBe("base");
  });
});

describe("generateRecommendations — Windows: NVIDIA GPU, CUDA present", () => {
  beforeEach(() => mockPlatform("win32"));

  it("recommends nvidia_cuda + Whisper (not Parakeet)", () => {
    const rec = new HardwareDetector().generateRecommendations({
      gpu: {
        available: true,
        vendor: "nvidia",
        model: "NVIDIA GeForce RTX 3080",
        vram: 10240,
        cuda: { available: true, version: "12.0" },
        metal: { available: false, version: null },
      },
      cpu: { count: 8 },
    });
    expect(rec.gpuCategory).toBe("nvidia_cuda");
    expect(rec.localTranscriptionProvider).toBe("whisper");
    expect(rec.parakeetModel).toBeUndefined();
  });

  it("produces no recovery steps when CUDA is available", () => {
    const rec = new HardwareDetector().generateRecommendations({
      gpu: {
        available: true,
        vendor: "nvidia",
        vram: 10240,
        cuda: { available: true, version: "12.0" },
        metal: { available: false, version: null },
      },
      cpu: { count: 8 },
    });
    expect((rec.recoverySteps as string[]).length).toBe(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// generateRecommendations — Linux scenarios
// ─────────────────────────────────────────────────────────────────────────────

describe("generateRecommendations — Linux: all GPU tools missing (cpu_only fallback)", () => {
  function linuxCpuOnly(cpuCount: number) {
    return {
      gpu: {
        available: false,
        vendor: null,
        model: null,
        vram: null,
        cuda: { available: false, version: null },
        metal: { available: false, version: null },
      },
      cpu: { count: cpuCount },
    };
  }

  beforeEach(() => mockPlatform("linux"));

  it("produces cpu_only gpuCategory", () => {
    expect(new HardwareDetector().generateRecommendations(linuxCpuOnly(4)).gpuCategory).toBe(
      "cpu_only"
    );
  });

  it("recommends whisper (CPU path) when no GPU detected", () => {
    expect(
      new HardwareDetector().generateRecommendations(linuxCpuOnly(8)).localTranscriptionProvider
    ).toBe("whisper");
  });

  it("recommends base model for a 4-core CPU — graceful fallback, not turbo", () => {
    expect(new HardwareDetector().generateRecommendations(linuxCpuOnly(4)).whisperModel).toBe(
      "base"
    );
  });

  it("recommends turbo model for an 8-core CPU", () => {
    expect(new HardwareDetector().generateRecommendations(linuxCpuOnly(8)).whisperModel).toBe(
      "turbo"
    );
  });

  it("recommends tiny model for a 2-core CPU", () => {
    expect(new HardwareDetector().generateRecommendations(linuxCpuOnly(2)).whisperModel).toBe(
      "tiny"
    );
  });

  it("Linux cpu_only reasoning explicitly mentions Linux support", () => {
    const combined = (
      new HardwareDetector().generateRecommendations(linuxCpuOnly(8)).reasoning as string[]
    )
      .join(" ")
      .toLowerCase();
    expect(combined).toContain("linux");
  });

  it("cpu_only reasoning does NOT mention CUDA or Parakeet", () => {
    const combined = (
      new HardwareDetector().generateRecommendations(linuxCpuOnly(8)).reasoning as string[]
    )
      .join(" ")
      .toLowerCase();
    expect(combined).not.toContain("parakeet");
    expect(combined).not.toContain("cuda");
  });
});

describe("generateRecommendations — Linux: NVIDIA detected via lspci only (nvidia_no_cuda)", () => {
  function linuxNvidiaLspciOnly(cpuCount = 8) {
    return {
      gpu: {
        available: true,
        vendor: "nvidia",
        model: "GeForce RTX 3060",
        vram: null, // lspci provides no VRAM info
        cuda: { available: false, version: null },
        metal: { available: false, version: null },
      },
      cpu: { count: cpuCount },
    };
  }

  beforeEach(() => mockPlatform("linux"));

  it("produces nvidia_no_cuda gpuCategory", () => {
    expect(
      new HardwareDetector().generateRecommendations(linuxNvidiaLspciOnly()).gpuCategory
    ).toBe("nvidia_no_cuda");
  });

  it("falls back to whisper — does NOT enable Parakeet GPU acceleration", () => {
    const rec = new HardwareDetector().generateRecommendations(linuxNvidiaLspciOnly());
    expect(rec.localTranscriptionProvider).toBe("whisper");
    expect(rec.parakeetModel).toBeUndefined();
  });

  it("provides Linux-specific recovery steps mentioning apt or dnf", () => {
    const combined = (
      new HardwareDetector().generateRecommendations(linuxNvidiaLspciOnly())
        .recoverySteps as string[]
    ).join(" ");
    expect(combined).toMatch(/apt|dnf/);
  });

  it("Linux recovery steps do NOT reference nvidia.com/drivers download page", () => {
    const combined = (
      new HardwareDetector().generateRecommendations(linuxNvidiaLspciOnly())
        .recoverySteps as string[]
    ).join(" ");
    expect(combined).not.toMatch(/nvidia\.com\/drivers/);
  });

  it("reasoning mentions the detected GPU model name", () => {
    const combined = (
      new HardwareDetector().generateRecommendations(linuxNvidiaLspciOnly()).reasoning as string[]
    ).join(" ");
    expect(combined).toContain("GeForce RTX 3060");
  });

  it("recommends turbo for an 8-core CPU when CUDA is absent", () => {
    expect(
      new HardwareDetector().generateRecommendations(linuxNvidiaLspciOnly(8)).whisperModel
    ).toBe("turbo");
  });
});

describe("generateRecommendations — Linux: AMD GPU via lspci (non_nvidia_gpu)", () => {
  beforeEach(() => mockPlatform("linux"));

  it("produces non_nvidia_gpu category for AMD", () => {
    const rec = new HardwareDetector().generateRecommendations({
      gpu: {
        available: true,
        vendor: "amd",
        model: "Radeon RX 6800",
        vram: null,
        cuda: { available: false, version: null },
        metal: { available: false, version: null },
      },
      cpu: { count: 8 },
    });
    expect(rec.gpuCategory).toBe("non_nvidia_gpu");
    expect(rec.localTranscriptionProvider).toBe("whisper");
  });

  it("Linux AMD reasoning mentions ROCm", () => {
    const combined = (
      new HardwareDetector().generateRecommendations({
        gpu: {
          available: true,
          vendor: "amd",
          model: "Radeon RX 6800",
          vram: null,
          cuda: { available: false, version: null },
          metal: { available: false, version: null },
        },
        cpu: { count: 8 },
      }).reasoning as string[]
    )
      .join(" ")
      .toLowerCase();
    expect(combined).toMatch(/rocm|amd/i);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Cross-platform recovery step content invariants
// ─────────────────────────────────────────────────────────────────────────────

describe("Platform-specific recovery step content invariants", () => {
  const nvidiaGpu = {
    available: true,
    vendor: "nvidia",
    model: "GTX 1050",
    vram: 4096,
    cuda: { available: false, version: null },
    metal: { available: false, version: null },
  };
  const cpu = { count: 8 };

  it("Windows recovery steps do NOT reference Linux package managers", () => {
    mockPlatform("win32");
    const combined = (
      new HardwareDetector().generateRecommendations({ gpu: nvidiaGpu, cpu })
        .recoverySteps as string[]
    ).join(" ");
    expect(combined).not.toMatch(/\bapt\b/);
    expect(combined).not.toMatch(/\bdnf\b/);
    expect(combined).not.toMatch(/\bpacman\b/);
  });

  it("Linux recovery steps do NOT reference the nvidia.com/drivers download page", () => {
    mockPlatform("linux");
    const combined = (
      new HardwareDetector().generateRecommendations({ gpu: nvidiaGpu, cpu })
        .recoverySteps as string[]
    ).join(" ");
    expect(combined).not.toMatch(/nvidia\.com\/drivers/);
    expect(combined).toMatch(/apt|dnf/);
  });

  it("Windows cpu_only reasoning does NOT mention Linux", () => {
    mockPlatform("win32");
    const combined = (
      new HardwareDetector().generateRecommendations({
        gpu: { available: false, vendor: null, model: null, vram: null, cuda: { available: false }, metal: { available: false } },
        cpu,
      }).reasoning as string[]
    )
      .join(" ")
      .toLowerCase();
    expect(combined).not.toContain("linux");
  });

  it("Linux cpu_only reasoning mentions Linux by name", () => {
    mockPlatform("linux");
    const combined = (
      new HardwareDetector().generateRecommendations({
        gpu: { available: false, vendor: null, model: null, vram: null, cuda: { available: false }, metal: { available: false } },
        cpu,
      }).reasoning as string[]
    )
      .join(" ")
      .toLowerCase();
    expect(combined).toContain("linux");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// pickBestWindowsGpuFromWmicOutput — pure function tests
// ─────────────────────────────────────────────────────────────────────────────

describe("pickBestWindowsGpuFromWmicOutput", () => {
  it("returns null for empty string", () => {
    expect(new HardwareDetector().pickBestWindowsGpuFromWmicOutput("")).toBeNull();
  });

  it("returns null for null input", () => {
    expect(new HardwareDetector().pickBestWindowsGpuFromWmicOutput(null)).toBeNull();
  });

  it("picks NVIDIA over Intel in a multi-GPU list", () => {
    const result = new HardwareDetector().pickBestWindowsGpuFromWmicOutput(WMIC_MULTI_GPU);
    expect(result?.vendor).toBe("nvidia");
    expect(result?.model).toContain("RTX 3080");
  });

  it("parses single NVIDIA GPU correctly", () => {
    const result = new HardwareDetector().pickBestWindowsGpuFromWmicOutput(WMIC_NVIDIA_ONLY);
    expect(result?.vendor).toBe("nvidia");
    expect(result?.model).toContain("GTX 1050");
  });

  it("parses VRAM from AdapterRAM bytes (4294967296 bytes = 4096 MiB)", () => {
    const result = new HardwareDetector().pickBestWindowsGpuFromWmicOutput(WMIC_NVIDIA_ONLY);
    expect(result?.vram).toBe(4096);
  });

  it("parses VRAM for 8 GiB GPU (8589934592 bytes = 8192 MiB)", () => {
    const result = new HardwareDetector().pickBestWindowsGpuFromWmicOutput(WMIC_MULTI_GPU);
    expect(result?.vram).toBe(8192);
  });

  it("skips Microsoft Basic Display Adapter entries", () => {
    const input =
      "Node,AdapterRAM,DriverVersion,Name\n" +
      "MYPC,4096,10.0.0.0,Microsoft Basic Display Adapter\n" +
      "MYPC,4294967296,30.0.15.1179,NVIDIA GeForce GTX 1050";
    const result = new HardwareDetector().pickBestWindowsGpuFromWmicOutput(input);
    expect(result?.model).toContain("GTX 1050");
  });

  it("selects AMD over Intel when both present", () => {
    const input =
      "Node,AdapterRAM,DriverVersion,Name\n" +
      "MYPC,4294967296,10.18.15.4279,Intel(R) UHD Graphics 630\n" +
      "MYPC,8589934592,27.20.14501.18003,AMD Radeon RX 6800";
    const result = new HardwareDetector().pickBestWindowsGpuFromWmicOutput(input);
    expect(result?.vendor).toBe("amd");
  });
});
