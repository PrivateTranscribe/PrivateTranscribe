const { execSync } = require("child_process");
const fs = require("fs");
const path = require("path");
const debugLogger = require("./debugLogger");

/**
 * Hardware detection utility for Privoca
 * Detects GPU capabilities to recommend optimal transcription settings
 */

class HardwareDetector {
  constructor() {
    this.cachedDetection = null;
  }

  /**
   * Detect available hardware capabilities
   * @returns {Object} Hardware detection results
   */
  async detectHardware() {
    if (this.cachedDetection) {
      return this.cachedDetection;
    }

    const detection = {
      timestamp: Date.now(),
      platform: process.platform,
      arch: process.arch,
      cpu: this.detectCPU(),
      gpu: await this.detectGPU(),
      recommendations: null,
    };

    // Generate recommendations based on detection
    detection.recommendations = this.generateRecommendations(detection);

    this.cachedDetection = detection;
    debugLogger.info("Hardware detection completed", detection);
    return detection;
  }

  /**
   * Detect CPU information
   */
  detectCPU() {
    try {
      const os = require("os");
      const cpus = os.cpus();

      return {
        count: cpus.length,
        model: cpus[0]?.model || "Unknown",
        speed: cpus[0]?.speed || 0,
      };
    } catch (error) {
      debugLogger.warn("CPU detection failed", { error: error.message });
      return { count: 0, model: "Unknown", speed: 0 };
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
      const wmicOutput = execSync(
        "wmic path win32_VideoController get Name, AdapterRAM, DriverVersion /format:csv",
        { encoding: "utf8", timeout: 5000 }
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
      const cudaOutput = execSync(
        "nvidia-smi --query-gpu=name,memory.total,driver_version --format=csv,noheader",
        {
          encoding: "utf8",
          timeout: 5000,
        }
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
        const systemProfiler = execSync("system_profiler SPDisplaysDataType -json", {
          encoding: "utf8",
          timeout: 5000,
        });

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
      const nvidiaOutput = execSync(
        "nvidia-smi --query-gpu=name,memory.total,driver_version --format=csv,noheader",
        {
          encoding: "utf8",
          timeout: 5000,
        }
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
            const cudaVersion = execSync(
              "nvcc --version 2>/dev/null | grep release | sed 's/.*release //' | sed 's/,.*//'",
              {
                encoding: "utf8",
                timeout: 3000,
              }
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
        const rocmOutput = execSync(
          "rocm-smi --showproductname --showmeminfo vram --csv 2>/dev/null",
          {
            encoding: "utf8",
            timeout: 5000,
          }
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
        const lspciOutput = execSync("lspci | grep -i vga", {
          encoding: "utf8",
          timeout: 5000,
        });

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
    const rec = {
      transcriptionProvider: "local",
      whisperModel: "turbo",
      localTranscriptionProvider: "whisper",
      gpuCategory: "cpu_only",
      reasoning: [],
      recoverySteps: [],
    };

    const { gpu, cpu } = detection;

    // Always return valid defaults — never null
    if (!gpu || !cpu) {
      rec.reasoning.push("Unable to detect hardware - using safe CPU defaults with Whisper");
      return rec;
    }

    // ── macOS Metal (early return — Whisper with Metal acceleration) ─────────
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

    // ── NVIDIA + CUDA — recommend Parakeet GPU acceleration ─────────────────
    if (gpu.vendor === "nvidia" && gpu.cuda.available) {
      rec.gpuCategory = "nvidia_cuda";
      rec.localTranscriptionProvider = "nvidia";
      rec.parakeetModel = "parakeet-tdt-0.6b-v3";
      rec.transcriptionProvider = "local";
      rec.reasoning.push(
        "NVIDIA GPU with CUDA detected - Parakeet recommended for GPU acceleration"
      );

      if (gpu.vram && gpu.vram >= 4096) {
        const vramDisplay =
          gpu.vram >= 1024 ? `${(gpu.vram / 1024).toFixed(1)} GB` : `${gpu.vram} MB`;
        rec.reasoning.push(`GPU has ${vramDisplay} VRAM — excellent for local transcription`);
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
        `NVIDIA GPU detected (${gpu.model || "GPU"}) but CUDA runtime is not available — falling back to CPU with Whisper`
      );
      rec.recoverySteps = [
        "Update or install NVIDIA drivers (v520 or later recommended) — download from nvidia.com/drivers",
        "Modern NVIDIA drivers (v450+) bundle the CUDA runtime libraries that Parakeet requires — no separate CUDA Toolkit install is needed for transcription",
        "After updating drivers, use 'Re-detect Hardware' in Privoca Settings → Transcription, or restart the app to enable Parakeet GPU acceleration",
      ];
    } else if (gpu.available && gpu.vendor && gpu.vendor !== "unknown") {
      // ── Non-NVIDIA GPU (AMD, Intel, etc.) — no current CUDA acceleration path ─
      rec.gpuCategory = "non_nvidia_gpu";
      rec.localTranscriptionProvider = "whisper";
      rec.transcriptionProvider = "local";
      const vendorName = this.getVendorDisplayName(gpu.vendor);
      rec.reasoning.push(
        `${vendorName} GPU detected — Whisper will run on CPU (GPU acceleration currently requires NVIDIA CUDA)`
      );
    } else {
      // ── CPU-only (no usable GPU) ─────────────────────────────────────────────
      rec.gpuCategory = "cpu_only";
      rec.localTranscriptionProvider = "whisper";
      rec.transcriptionProvider = "local";
      rec.reasoning.push("No GPU acceleration available - using Whisper on CPU");
    }

    // CPU-core-based model sizing for all non-GPU-accelerated paths
    if (cpu.count >= 8) {
      rec.whisperModel = "turbo";
      rec.reasoning.push(
        `Multi-core CPU (${cpu.count} cores) - Turbo model recommended for best quality`
      );
    } else if (cpu.count >= 4) {
      rec.whisperModel = "base";
      rec.reasoning.push(`Quad-core CPU (${cpu.count} cores) - Base model recommended for speed`);
    } else {
      rec.whisperModel = "tiny";
      rec.reasoning.push(`Limited CPU cores (${cpu.count}) - Tiny model recommended for speed`);
    }

    return rec;
  }

  /**
   * Clear cached detection (for re-detection)
   */
  clearCache() {
    this.cachedDetection = null;
  }
}

module.exports = HardwareDetector;
