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
   * Detect GPU on Windows
   */
  async detectWindowsGPU(gpu) {
    try {
      // Try WMIC first for GPU info. WMIC typically returns CSV with a header like:
      // Node,AdapterRAM,DriverVersion,Name
      const wmicOutput = execSync(
        "wmic path win32_VideoController get Name, AdapterRAM, DriverVersion /format:csv",
        { encoding: "utf8", timeout: 5000 },
      );

      const lines = wmicOutput
        .trim()
        .split("\n")
        .map((l) => l.trim())
        .filter((l) => l.length > 0);

      const headerLine = lines.find((l) => l.toLowerCase().includes("adapterram") && l.toLowerCase().includes("name"));
      const headers = headerLine ? headerLine.split(",").map((h) => h.trim().toLowerCase()) : null;

      const vendorLine = lines.find((line) =>
        line.includes("NVIDIA") || line.includes("AMD") || line.includes("Intel"),
      );

      if (vendorLine) {
        const parts = vendorLine.split(",").map((p) => p.trim());

        // Prefer header-based indexing when available; otherwise use best-effort matching.
        if (headers) {
          const nameIdx = headers.indexOf("name");
          const ramIdx = headers.indexOf("adapterram");

          const name = nameIdx >= 0 ? parts[nameIdx] : null;
          const adapterRam = ramIdx >= 0 ? parts[ramIdx] : null;

          if (name) {
            gpu.model = name;
            gpu.vendor = this.identifyVendor(gpu.model);
            gpu.available = true;
          }

          if (adapterRam) {
            gpu.vram = this.parseVRAM(adapterRam);
          }
        } else {
          const name = parts.find((p) => p.includes("NVIDIA") || p.includes("AMD") || p.includes("Intel"));
          if (name) {
            gpu.model = name;
            gpu.vendor = this.identifyVendor(gpu.model);
            gpu.available = true;
          }

          const adapterRam = parts.find((p) => /^\d+$/.test(p));
          if (adapterRam) {
            gpu.vram = this.parseVRAM(adapterRam);
          }
        }
      }
    } catch (error) {
      debugLogger.debug("WMIC GPU detection failed", { error: error.message });
    }

    // Check for CUDA
    try {
      const cudaOutput = execSync("nvidia-smi --query-gpu=name,memory.total,driver_version --format=csv,noheader", {
        encoding: "utf8",
        timeout: 5000,
      });
      
      if (cudaOutput) {
        const parts = cudaOutput.trim().split(",").map(p => p.trim());
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
        debugLogger.debug("system_profiler failed, using Metal defaults", { error: profilerError.message });
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
      const nvidiaOutput = execSync("nvidia-smi --query-gpu=name,memory.total,driver_version --format=csv,noheader", {
        encoding: "utf8",
        timeout: 5000,
      });
      
      if (nvidiaOutput) {
        const parts = nvidiaOutput.trim().split(",").map(p => p.trim());
        if (parts.length >= 3) {
          gpu.model = parts[0];
          gpu.vendor = "nvidia";
          gpu.vram = this.parseVRAM(parts[1]);
          gpu.available = true;
          gpu.cuda.available = true;
          
          // Try to get CUDA version
          try {
            const cudaVersion = execSync("nvcc --version 2>/dev/null | grep release | sed 's/.*release //' | sed 's/,.*//'", {
              encoding: "utf8",
              timeout: 3000,
            });
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
        const rocmOutput = execSync("rocm-smi --showproductname --showmeminfo vram --csv 2>/dev/null", {
          encoding: "utf8",
          timeout: 5000,
        });
        
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
   * Identify GPU vendor from model string
   */
  identifyVendor(model) {
    const lower = model.toLowerCase();
    if (lower.includes("nvidia") || lower.includes("geforce") || lower.includes("rtx") || lower.includes("gtx")) {
      return "nvidia";
    } else if (lower.includes("amd") || lower.includes("radeon") || lower.includes("ati")) {
      return "amd";
    } else if (lower.includes("intel") || lower.includes("arc") || lower.includes("iris") || lower.includes("hd graphics")) {
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
   * Generate recommendations based on hardware detection
   */
  generateRecommendations(detection) {
    const rec = {
      transcriptionProvider: "local", // Always default to local for CPU fallback
      whisperModel: "base",
      localTranscriptionProvider: "whisper", // Default to whisper (CPU-safe fallback)
      reasoning: [],
    };

    const { gpu, cpu } = detection;

    // Ensure recommendations is never null - always return valid default
    if (!gpu || !cpu) {
      rec.reasoning.push("Unable to detect hardware - using safe CPU defaults with Whisper");
      return rec;
    }

    // Special check: if Metal is available (macOS), recommend optimized Whisper settings
    // Improved Metal detection: Check both metal.available AND gpu.available flags
    if (gpu.metal?.available && gpu.available) {
      rec.localTranscriptionProvider = "whisper";
      rec.transcriptionProvider = "local";

      if (gpu.vendor === "apple" || process.arch === "arm64") {
        rec.whisperModel = "small";
        rec.reasoning.push("Apple Silicon detected - using optimized Whisper with Metal acceleration");
      } else if (gpu.vendor === "intel" || gpu.vendor === "amd") {
        rec.whisperModel = "small";
        rec.reasoning.push("Metal GPU detected - Whisper will use Metal acceleration");
      } else {
        // Fallback for macOS with Metal but unidentified GPU
        rec.whisperModel = "base";
        rec.reasoning.push("Metal GPU support detected - using Whisper with hardware acceleration");
      }

      // Return early for Metal - no need to check other conditions
      return rec;
    }

    // NVIDIA GPU with CUDA - recommend Parakeet
    if (gpu.vendor === "nvidia" && gpu.cuda.available) {
      rec.localTranscriptionProvider = "nvidia";
      rec.parakeetModel = "parakeet-tdt-0.6b-v3";
      rec.transcriptionProvider = "local"; // Ensure local provider for GPU case
      rec.reasoning.push("NVIDIA GPU with CUDA detected - Parakeet recommended for GPU acceleration");

      // Check VRAM for model recommendations
      if (gpu.vram && gpu.vram >= 4096) {
        rec.reasoning.push(`GPU has ${gpu.vram}MB VRAM - excellent for local transcription`);
      }
    } else {
      // CPU-only or unsupported GPU
      rec.localTranscriptionProvider = "whisper";
      rec.transcriptionProvider = "local"; // Ensure local provider for CPU fallback
      rec.reasoning.push("No GPU acceleration available - using Whisper on CPU");

      // Adjust model size based on CPU cores
      if (cpu.count >= 8) {
        rec.whisperModel = "small";
        rec.reasoning.push(`Multi-core CPU (${cpu.count} cores) - Small model recommended`);
      } else if (cpu.count >= 4) {
        rec.whisperModel = "base";
        rec.reasoning.push(`Quad-core CPU (${cpu.count} cores) - Base model recommended`);
      } else {
        rec.whisperModel = "tiny";
        rec.reasoning.push(`Limited CPU cores (${cpu.count}) - Tiny model recommended for speed`);
      }
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
