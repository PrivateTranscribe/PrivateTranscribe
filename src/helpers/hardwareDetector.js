const { exec } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");
const debugLogger = require("./debugLogger");
// Module objects, not destructured, so tests can spy on the probes.
const cpuFeatures = require("./cpuFeatures");
const cpuThreads = require("./cpuThreads");
const { evaluateParakeetHardware } = require("./parakeetEligibility");

/**
 * Hardware detection utility for PrivateTranscribe
 * Detects GPU capabilities to recommend optimal transcription settings
 */

class HardwareDetector {
  constructor() {
    this.cachedDetection = null;
    this.detectionPromise = null;
  }

  /**
   * Detect available hardware capabilities
   * @returns {Object} Hardware detection results
   */
  async detectHardware() {
    if (this.cachedDetection) {
      return this.cachedDetection;
    }

    if (this.detectionPromise) {
      return this.detectionPromise;
    }

    this.detectionPromise = this.buildDetection()
      .then((detection) => {
        this.cachedDetection = detection;
        debugLogger.info("Hardware detection completed", detection);
        return detection;
      })
      .finally(() => {
        this.detectionPromise = null;
      });

    return this.detectionPromise;
  }

  /**
   * Run a shell command asynchronously and resolve with its stdout.
   *
   * Detection probes (wmic, nvidia-smi, system_profiler, ...) can take seconds
   * — e.g. nvidia-smi has to wake a sleeping dGPU on hybrid-graphics laptops —
   * so they must never run synchronously on the Electron main process.
   * Rejects on non-zero exit, missing command, or timeout.
   */
  execCommand(command, { timeout = 5000 } = {}) {
    return new Promise((resolve, reject) => {
      exec(command, { encoding: "utf8", timeout, windowsHide: true }, (error, stdout) => {
        if (error) reject(error);
        else resolve(stdout);
      });
    });
  }

  async buildDetection() {
    // The CPU probes each spawn a process, so they run alongside GPU detection.
    const [cpu, gpu] = await Promise.all([this.detectCPU(), this.detectGPU()]);

    const detection = {
      timestamp: Date.now(),
      platform: process.platform,
      arch: process.arch,
      cpu,
      gpu,
      memory: this.detectMemory(),
      recommendations: null,
    };

    // Generate recommendations based on detection
    detection.recommendations = this.generateRecommendations(detection);

    return detection;
  }

  /**
   * Detect CPU information
   */
  async detectCPU() {
    let cpu;
    try {
      const cpus = os.cpus();
      cpu = {
        count: cpus.length,
        model: cpus[0]?.model || "Unknown",
        speed: cpus[0]?.speed || 0,
      };
    } catch (error) {
      debugLogger.warn("CPU detection failed", { error: error.message });
      cpu = { count: 0, model: "Unknown", speed: 0 };
    }

    const [physicalCores, avx2] = await Promise.all([
      this.detectPhysicalCores(),
      this.detectAvx2(),
    ]);
    return { ...cpu, physicalCores, avx2 };
  }

  /** @returns {Promise<number|null>} */
  async detectPhysicalCores() {
    try {
      const cores = await cpuThreads.warmCpuTopology();
      return Number.isInteger(cores) && cores > 0 ? cores : null;
    } catch (error) {
      debugLogger.debug("Physical core detection failed", { error: error.message });
      return null;
    }
  }

  /** @returns {Promise<boolean|null>} */
  async detectAvx2() {
    try {
      return await cpuFeatures.detectAvx2();
    } catch (error) {
      debugLogger.debug("AVX2 detection failed", { error: error.message });
      return null;
    }
  }

  detectMemory() {
    try {
      return { totalBytes: os.totalmem() };
    } catch (error) {
      debugLogger.warn("Memory detection failed", { error: error.message });
      return { totalBytes: 0 };
    }
  }

  /**
   * Detect GPU capabilities
   */
  async detectGPU() {
    const gpu = {
      available: false,
      vendor: null,
      model: null,
      vram: null,
      cuda: { available: false, version: null },
      metal: { available: false, version: null },
      directml: { available: false },
      rocm: { available: false, version: null },
    };

    try {
      if (process.platform === "win32") {
        await this.detectWindowsGPU(gpu);
      } else if (process.platform === "darwin") {
        await this.detectMacGPU(gpu);
      } else if (process.platform === "linux") {
        await this.detectLinuxGPU(gpu);
      }
    } catch (error) {
      debugLogger.warn("GPU detection error", { error: error.message });
    }

    return gpu;
  }

  /**
   * Pick the best GPU candidate from WMIC win32_VideoController CSV output.
   *
   * WMIC often lists multiple GPUs (e.g., Intel iGPU + NVIDIA dGPU). We prefer
   * discrete GPUs by vendor and then by VRAM.
   *
   * @param {string} wmicOutput
   * @returns {{ model: string|null, vendor: string|null, vram: number|null }|null}
   */
  pickBestWindowsGpuFromWmicOutput(wmicOutput) {
    if (!wmicOutput || typeof wmicOutput !== "string") return null;

    const lines = wmicOutput
      .trim()
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l.length > 0);

    if (lines.length === 0) return null;

    const headerLine = lines.find(
      (l) => l.toLowerCase().includes("adapterram") && l.toLowerCase().includes("name")
    );

    const headers = headerLine ? headerLine.split(",").map((h) => h.trim().toLowerCase()) : null;

    const nameIdx = headers ? headers.indexOf("name") : -1;
    const ramIdx = headers ? headers.indexOf("adapterram") : -1;

    const vendorWeight = { nvidia: 3, amd: 2, intel: 1, apple: 0, unknown: 0 };

    const candidates = [];

    for (const line of lines) {
      if (headers && line === headerLine) continue;

      const parts = line.split(",").map((p) => p.trim());
      const getPart = (i) => (i >= 0 && i < parts.length ? parts[i] : null);

      const name =
        (nameIdx >= 0 ? getPart(nameIdx) : null) ||
        parts.find((p) => p.includes("NVIDIA") || p.includes("AMD") || p.includes("Intel")) ||
        null;

      if (!name) continue;

      const lowerName = name.toLowerCase();
      if (lowerName.includes("microsoft basic display")) continue;

      const vendor = this.identifyVendor(name);

      const adapterRam =
        (ramIdx >= 0 ? getPart(ramIdx) : null) || parts.find((p) => /^\d+$/.test(p)) || null;

      const vram = adapterRam ? this.parseVRAM(adapterRam) : null;

      candidates.push({
        model: name,
        vendor: vendor === "unknown" ? null : vendor,
        vram,
        _vendorWeight: vendorWeight[vendor] ?? 0,
      });
    }

    if (candidates.length === 0) return null;

    candidates.sort((a, b) => {
      if (a._vendorWeight !== b._vendorWeight) return b._vendorWeight - a._vendorWeight;
      const av = a.vram ?? -1;
      const bv = b.vram ?? -1;
      return bv - av;
    });

    const best = candidates[0];
    return { model: best.model, vendor: best.vendor, vram: best.vram };
  }

  /**
   * Detect GPU on Windows
   */
  async detectWindowsGPU(gpu) {
    try {
      // Try WMIC first for GPU info. WMIC typically returns CSV with a header like:
      // Node,AdapterRAM,DriverVersion,Name
      const wmicOutput = await this.execCommand(
        "wmic path win32_VideoController get Name, AdapterRAM, DriverVersion /format:csv"
      );

      const best = this.pickBestWindowsGpuFromWmicOutput(wmicOutput);
      if (best) {
        gpu.model = best.model;
        gpu.vendor = best.vendor || this.identifyVendor(best.model);
        gpu.vram = best.vram;
        gpu.available = true;
      }
    } catch (error) {
      debugLogger.debug("WMIC GPU detection failed", { error: error.message });
    }

    // Check for CUDA
    try {
      const cudaOutput = await this.execCommand(
        "nvidia-smi --query-gpu=name,memory.total,driver_version --format=csv,noheader"
      );

      if (cudaOutput) {
        const parts = cudaOutput
          .trim()
          .split(",")
          .map((p) => p.trim());
        if (parts.length >= 3) {
          gpu.model = parts[0];
          gpu.vendor = "nvidia";
          gpu.vram = this.parseVRAM(parts[1]);
          gpu.available = true;
          gpu.cuda.available = true;
        }
      }
    } catch (error) {
      debugLogger.debug("nvidia-smi not available", { error: error.message });
    }

    // Check DirectML support (Windows ML)
    if (gpu.vendor === "nvidia" || gpu.vendor === "amd" || gpu.vendor === "intel") {
      gpu.directml.available = true;
    }
  }

  /**
   * Detect GPU on macOS
   */
  async detectMacGPU(gpu) {
    try {
      // Always check macOS version first for Metal support
      const osRelease = require("os").release();
      const darwinMajor = parseFloat(osRelease);
      const macOSSupportsMetal = darwinMajor >= 18; // macOS 10.14 Mojave (Darwin 18) minimum
      const isAppleSilicon = process.arch === "arm64";

      // Set Metal defaults FIRST if supported by OS, then try to refine with system_profiler
      if (macOSSupportsMetal) {
        gpu.metal.available = true;
        gpu.metal.version = this.getMetalVersion(osRelease);
        gpu.available = true;

        if (isAppleSilicon) {
          gpu.vendor = "apple";
          gpu.model = "Apple Silicon GPU";
        } else {
          // Default for Intel Macs with Metal support
          gpu.vendor = "intel"; // More accurate default for Intel Macs
          gpu.model = "Intel Mac GPU";
        }
      }

      // Now try system_profiler to refine the GPU info (best effort)
      try {
        const systemProfiler = await this.execCommand("system_profiler SPDisplaysDataType -json");

        const data = JSON.parse(systemProfiler);
        const displays = data?.SPDisplaysDataType || [];

        for (const display of displays) {
          const name = display?.sppci_model || display?._name;
          if (name) {
            // Only override model if we got a better name
            gpu.model = name;
            const identifiedVendor = this.identifyVendor(name);

            // Override vendor only if identification is successful and non-unknown
            if (identifiedVendor !== "unknown") {
              gpu.vendor = identifiedVendor;
            } else if (isAppleSilicon) {
              // Keep Apple Silicon vendor if identification failed on ARM
              gpu.vendor = "apple";
            } else {
              // Keep intel default for Intel Macs if identification failed
              gpu.vendor = "intel";
            }

            break;
          }
        }
      } catch (profilerError) {
        debugLogger.debug("system_profiler failed, using Metal defaults", {
          error: profilerError.message,
        });
        // Metal defaults are already set, so this is fine
      }
    } catch (error) {
      debugLogger.warn("macOS GPU detection error", { error: error.message });

      // Final fallback: try to at least detect Metal support
      try {
        const osRelease = require("os").release();
        const darwinMajor = parseFloat(osRelease);
        if (darwinMajor >= 18) {
          gpu.metal.available = true;
          gpu.metal.version = this.getMetalVersion(osRelease);
          gpu.available = true;

          if (process.arch === "arm64") {
            gpu.vendor = "apple";
            gpu.model = "Apple Silicon GPU";
          } else {
            gpu.vendor = "intel";
            gpu.model = "Intel Mac GPU";
          }
        }
      } catch {
        debugLogger.warn("Final Metal fallback failed - GPU detection completely failed");
      }
    }
  }

  /**
   * Detect GPU on Linux
   */
  async detectLinuxGPU(gpu) {
    // Try nvidia-smi first for NVIDIA GPUs
    try {
      const nvidiaOutput = await this.execCommand(
        "nvidia-smi --query-gpu=name,memory.total,driver_version --format=csv,noheader"
      );

      if (nvidiaOutput) {
        const parts = nvidiaOutput
          .trim()
          .split(",")
          .map((p) => p.trim());
        if (parts.length >= 3) {
          gpu.model = parts[0];
          gpu.vendor = "nvidia";
          gpu.vram = this.parseVRAM(parts[1]);
          gpu.available = true;
          gpu.cuda.available = true;

          // Try to get CUDA version
          try {
            const cudaVersion = await this.execCommand(
              "nvcc --version 2>/dev/null | grep release | sed 's/.*release //' | sed 's/,.*//'",
              { timeout: 3000 }
            );
            if (cudaVersion) {
              gpu.cuda.version = cudaVersion.trim();
            }
          } catch {
            // nvcc not available, that's ok
          }
        }
      }
    } catch (error) {
      debugLogger.debug("nvidia-smi not available on Linux", { error: error.message });
    }

    // Try ROCm for AMD GPUs if no NVIDIA GPU found
    if (!gpu.available) {
      try {
        const rocmOutput = await this.execCommand(
          "rocm-smi --showproductname --showmeminfo vram --csv 2>/dev/null"
        );

        if (rocmOutput && rocmOutput.includes("AMD")) {
          gpu.vendor = "amd";
          gpu.available = true;
          gpu.rocm.available = true;
        }
      } catch (error) {
        debugLogger.debug("rocm-smi not available", { error: error.message });
      }
    }

    // Try lspci as fallback
    if (!gpu.available) {
      try {
        const lspciOutput = await this.execCommand("lspci | grep -i vga");

        if (lspciOutput) {
          const line = lspciOutput.split("\n")[0];
          if (line.includes("NVIDIA")) {
            gpu.vendor = "nvidia";
            gpu.available = true;
          } else if (line.includes("AMD") || line.includes("ATI")) {
            gpu.vendor = "amd";
            gpu.available = true;
          } else if (line.includes("Intel")) {
            gpu.vendor = "intel";
            gpu.available = true;
          }

          const match = line.match(/\[([^\]]+)\]/);
          if (match) {
            gpu.model = match[1];
          }
        }
      } catch (error) {
        debugLogger.debug("lspci detection failed", { error: error.message });
      }
    }
  }

  /**
   * Return a properly-capitalised display name for an internal vendor key.
   *
   * Internal keys are lowercase (nvidia, amd, intel, apple, unknown).
   * The UI should always call this rather than naively title-casing the raw key,
   * because "amd".charAt(0).toUpperCase() + "amd".slice(1) === "Amd" which is wrong.
   */
  getVendorDisplayName(vendor) {
    const names = {
      nvidia: "NVIDIA",
      amd: "AMD",
      intel: "Intel",
      apple: "Apple",
      unknown: "Unknown",
    };
    return names[vendor] ?? (vendor ? vendor.charAt(0).toUpperCase() + vendor.slice(1) : "Unknown");
  }

  /**
   * Identify GPU vendor from model string
   */
  identifyVendor(model) {
    const lower = model.toLowerCase();
    if (
      lower.includes("nvidia") ||
      lower.includes("geforce") ||
      lower.includes("rtx") ||
      lower.includes("gtx")
    ) {
      return "nvidia";
    } else if (lower.includes("amd") || lower.includes("radeon") || lower.includes("ati")) {
      return "amd";
    } else if (
      lower.includes("intel") ||
      lower.includes("arc") ||
      lower.includes("iris") ||
      lower.includes("hd graphics")
    ) {
      return "intel";
    } else if (lower.includes("apple")) {
      return "apple";
    }
    return "unknown";
  }

  /**
   * Parse VRAM input into MiB (MB-ish) as an integer.
   *
   * Accepts formats like:
   * - "8192 MiB" (nvidia-smi)
   * - "8 GiB"
   * - "8 GB" / "8192 MB"
   * - "10,240 MiB" (comma-separated)
   * - "8589934592" (bytes, e.g. WMIC AdapterRAM)
   */
  parseVRAM(vramInput) {
    if (vramInput === null || vramInput === undefined) return null;

    // If we already got a number, attempt to interpret it sensibly.
    if (typeof vramInput === "number" && Number.isFinite(vramInput)) {
      // Heuristic: large numbers are likely bytes.
      if (vramInput > 1024 * 1024 * 16) {
        return Math.round(vramInput / (1024 * 1024));
      }
      return Math.round(vramInput);
    }

    const vramStr = String(vramInput).trim();
    if (!vramStr) return null;

    // Pure numeric string: assume bytes (WMIC AdapterRAM often returns bytes).
    if (/^\d+$/.test(vramStr)) {
      const bytes = Number(vramStr);
      if (!Number.isFinite(bytes) || bytes <= 0) return null;
      return Math.round(bytes / (1024 * 1024));
    }

    // Allow comma separators and optional whitespace between value and unit.
    const match = vramStr.match(/(\d{1,3}(?:,\d{3})*|\d+)(?:\.(\d+))?\s*(mib|gib|mb|gb)/i);
    if (!match) return null;

    const whole = match[1].replace(/,/g, "");
    const decimal = match[2] ? `.${match[2]}` : "";
    const value = Number(`${whole}${decimal}`);
    if (!Number.isFinite(value) || value <= 0) return null;

    const unit = match[3].toLowerCase();

    // Convert GiB/GB to MiB (binary 1024-based) for internal consistency.
    if (unit === "gib" || unit === "gb") return Math.round(value * 1024);

    return Math.round(value);
  }

  /**
   * Get Metal version from Darwin kernel version
   */
  getMetalVersion(darwinRelease) {
    const version = parseFloat(darwinRelease);
    if (version >= 24) return "3.2"; // macOS 15+
    if (version >= 23) return "3.1"; // macOS 14+
    if (version >= 22) return "3.0"; // macOS 13+
    if (version >= 21) return "2.4"; // macOS 12+
    return "2.0";
  }

  /**
   * Generate recommendations based on hardware detection.
   *
   * Returns a recommendation object with:
   * - gpuCategory: 'nvidia_cuda' | 'nvidia_no_cuda' | 'non_nvidia_gpu' | 'metal' | 'cpu_only'
   * - recoverySteps: actionable steps to enable GPU acceleration (populated for 'nvidia_no_cuda')
   * - reasoning: human-readable explanation bullets shown in onboarding UI
   */
  generateRecommendations(detection) {
    // Every path below overrides whisperModel; only the detection-failed default
    // keeps it, and with the hardware unknown it must be a model a CPU can run.
    const rec = {
      transcriptionProvider: "local",
      whisperModel: "base",
      localTranscriptionProvider: "whisper",
      gpuCategory: "cpu_only",
      reasoning: [],
      recoverySteps: [],
      parakeetHardware: { eligible: false, reasons: ["Could not check this PC's hardware."] },
    };

    const { gpu, cpu } = detection;

    // Always return valid defaults - never null
    if (!gpu || !cpu) {
      rec.reasoning.push("Unable to detect hardware - using safe CPU defaults with Whisper");
      return rec;
    }

    // Computed for every category: a CUDA PC keeps GPU Whisper as its default
    // but may still pick Parakeet in Settings when this passes.
    rec.parakeetHardware = evaluateParakeetHardware({
      physicalCores: cpu.physicalCores ?? null,
      avx2: cpu.avx2 ?? null,
      totalBytes: detection.memory?.totalBytes ?? null,
      logicalCores: cpu.count ?? null,
    });

    // ── macOS Metal (early return - Whisper with Metal acceleration) ─────────
    if (gpu.metal?.available && gpu.available) {
      rec.gpuCategory = "metal";
      rec.localTranscriptionProvider = "whisper";
      rec.transcriptionProvider = "local";

      if (gpu.vendor === "apple" || process.arch === "arm64") {
        rec.whisperModel = "small";
        rec.reasoning.push(
          "Apple Silicon detected - using optimized Whisper with Metal acceleration"
        );
      } else if (gpu.vendor === "intel" || gpu.vendor === "amd") {
        rec.whisperModel = "small";
        rec.reasoning.push("Metal GPU detected - Whisper will use Metal acceleration");
      } else {
        rec.whisperModel = "base";
        rec.reasoning.push("Metal GPU support detected - using Whisper with hardware acceleration");
      }

      return rec;
    }

    // ── NVIDIA + CUDA - recommend Whisper with CUDA acceleration ────────────
    if (gpu.vendor === "nvidia" && gpu.cuda.available) {
      const vramMb = typeof gpu.vram === "number" ? gpu.vram : 0;
      const vramDisplay =
        vramMb >= 1024 ? `${(vramMb / 1024).toFixed(1)} GB` : vramMb ? `${vramMb} MB` : null;

      rec.gpuCategory = "nvidia_cuda";
      rec.localTranscriptionProvider = "whisper";
      rec.whisperModel =
        vramMb >= 12288
          ? "large"
          : vramMb >= 6144 || vramMb === 0
            ? "turbo"
            : vramMb >= 4096
              ? "small"
              : "base";
      rec.transcriptionProvider = "local";

      if (rec.whisperModel === "large") {
        rec.reasoning.push(
          `NVIDIA graphics card${vramDisplay ? ` with ${vramDisplay} of memory` : ""}. Whisper Large picked for the best accuracy.`
        );
      } else if (rec.whisperModel === "turbo") {
        rec.reasoning.push("NVIDIA graphics card. Whisper Turbo picked for speed on the GPU.");
      } else {
        rec.reasoning.push(
          `NVIDIA graphics card${vramDisplay ? ` with ${vramDisplay} of memory` : ""}. Whisper ${rec.whisperModel === "small" ? "Small" : "Base"} picked so it fits comfortably.`
        );
      }

      if (vramMb >= 4096) {
        rec.reasoning.push(`${vramDisplay} of graphics memory is plenty for local transcription.`);
      }

      return rec;
    }

    // ── NVIDIA GPU present but CUDA runtime unavailable ──────────────────────
    // (e.g. drivers missing, GPU detected via lspci but nvidia-smi failed)
    if (gpu.vendor === "nvidia" && gpu.available) {
      rec.gpuCategory = "nvidia_no_cuda";
      rec.localTranscriptionProvider = "whisper";
      rec.transcriptionProvider = "local";
      rec.reasoning.push(
        `NVIDIA GPU detected (${gpu.model || "GPU"}) but CUDA runtime is not available - falling back to CPU with Whisper`
      );
      if (process.platform === "linux") {
        rec.recoverySteps = [
          "Install NVIDIA drivers via your package manager - e.g. `sudo apt install nvidia-driver-535` (Ubuntu/Debian) or `sudo dnf install akmod-nvidia` (Fedora/RHEL)",
          "Modern NVIDIA drivers (v450+) bundle the CUDA runtime needed for GPU-accelerated inference - no separate CUDA Toolkit install is required",
          "After installing drivers, restart your system, then use 'Re-detect Hardware' in PrivateTranscribe Settings → Transcription to enable Whisper GPU acceleration",
        ];
      } else {
        rec.recoverySteps = [
          "Update or install NVIDIA drivers (v520 or later recommended) - download from nvidia.com/drivers",
          "Modern NVIDIA drivers (v450+) bundle the CUDA runtime libraries needed for GPU-accelerated inference - no separate CUDA Toolkit install is needed for transcription",
          "After updating drivers, use 'Re-detect Hardware' in PrivateTranscribe Settings → Transcription, or restart the app to enable Whisper GPU acceleration",
        ];
      }
    } else if (gpu.available && gpu.vendor && gpu.vendor !== "unknown") {
      // ── Non-NVIDIA GPU (AMD, Intel, etc.) - no current CUDA acceleration path ─
      rec.gpuCategory = "non_nvidia_gpu";
      rec.localTranscriptionProvider = "whisper";
      rec.transcriptionProvider = "local";
      const vendorName = this.getVendorDisplayName(gpu.vendor);
      if (process.platform === "linux") {
        rec.reasoning.push(
          `${vendorName} GPU detected - Whisper will run on CPU (GPU acceleration currently requires NVIDIA CUDA on this platform)`
        );
      } else {
        rec.reasoning.push(
          `${vendorName} GPU detected - Whisper will run on CPU (GPU acceleration currently requires NVIDIA CUDA)`
        );
      }
    } else {
      // ── CPU-only (no usable GPU) ─────────────────────────────────────────────
      rec.gpuCategory = "cpu_only";
      rec.localTranscriptionProvider = "whisper";
      rec.transcriptionProvider = "local";
      if (process.platform === "linux") {
        rec.reasoning.push(
          "No GPU detected - Whisper runs well on CPU and is fully supported on Linux"
        );
      } else {
        rec.reasoning.push("No GPU acceleration available - using Whisper on CPU");
      }
    }

    // CPU-core-based model sizing for all non-GPU-accelerated paths.
    //
    // os.cpus().length counts logical threads, not physical cores, so a 2014
    // quad-core (e.g. i7-4790, 4 cores / 8 threads) reports 8. Turbo and Large
    // are big models built for GPU acceleration - on CPU they are painfully slow
    // and on older machines feel like a hang. Never recommend them on the CPU
    // path; favor small/fast models that actually finish quickly.
    if (cpu.count >= 16) {
      rec.whisperModel = "small";
      rec.reasoning.push(
        `${cpu.count}-thread processor. Whisper Small balances speed and accuracy without a GPU.`
      );
    } else if (cpu.count >= 4) {
      rec.whisperModel = "base";
      rec.reasoning.push(
        `${cpu.count}-thread processor. Whisper Base keeps transcription quick without a GPU.`
      );
    } else {
      rec.whisperModel = "tiny";
      rec.reasoning.push(`${cpu.count}-thread processor. Whisper Tiny picked so it stays fast.`);
    }

    return rec;
  }

  /**
   * Clear cached detection (for re-detection)
   */
  clearCache() {
    this.cachedDetection = null;
    this.detectionPromise = null;
  }
}

module.exports = HardwareDetector;
