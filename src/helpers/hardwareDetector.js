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
      // Try WMIC first for GPU info
      const wmicOutput = execSync(
        "wmic path win32_VideoController get Name, AdapterRAM, DriverVersion /format:csv",
        { encoding: "utf8", timeout: 5000 }
      );
      
      const lines = wmicOutput.trim().split("\n").filter(line => line.trim());
      const dataLine = lines.find(line => line.includes("NVIDIA") || line.includes("AMD") || line.includes("Intel"));
      
      if (dataLine) {
        const parts = dataLine.split(",");
        const name = parts.find(p => p.includes("NVIDIA") || p.includes("AMD") || p.includes("Intel"));
        if (name) {
          gpu.model = name.trim();
          gpu.vendor = this.identifyVendor(gpu.model);
          gpu.available = true;
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

      const systemProfiler = execSync("system_profiler SPDisplaysDataType -json", {
        encoding: "utf8",
        timeout: 5000,
      });

      const data = JSON.parse(systemProfiler);
      const displays = data?.SPDisplaysDataType || [];

      for (const display of displays) {
        const name = display?.sppci_model || display?._name;
        if (name) {
          gpu.model = name;
          gpu.vendor = this.identifyVendor(name);
          gpu.available = true;

          // Check for Apple Silicon first (most reliable indicator)
          if (isAppleSilicon) {
            gpu.vendor = "apple";
            gpu.metal.available = true;
            gpu.metal.version = this.getMetalVersion(osRelease);
          } else if (macOSSupportsMetal) {
            // Intel/AMD Mac with Metal support
            gpu.metal.available = true;
            gpu.metal.version = this.getMetalVersion(osRelease);
          }

          break;
        }
      }

      // If no GPU model found but we're on a Metal-capable system, set defaults
      if (!gpu.model && macOSSupportsMetal) {
        gpu.available = true;
        gpu.metal.available = true;
        gpu.metal.version = this.getMetalVersion(osRelease);
        if (isAppleSilicon) {
          gpu.vendor = "apple";
          gpu.model = "Apple Silicon";
        } else {
          gpu.vendor = "unknown";
          gpu.model = "Mac GPU (Metal)";
        }
      }
    } catch (error) {
      debugLogger.debug("macOS GPU detection failed", { error: error.message });

      // Fallback: on any modern macOS (Darwin 18+) assume Metal is available
      try {
        const osRelease = require("os").release();
        const darwinMajor = parseFloat(osRelease);
        if (darwinMajor >= 18) {
          gpu.metal.available = true;
          gpu.metal.version = this.getMetalVersion(osRelease);
          // Mark available so recommendations pick up Metal
          gpu.available = true;
          if (process.arch === "arm64") {
            gpu.vendor = "apple";
            gpu.model = "Apple Silicon";
          } else {
            // Intel or AMD Mac with Metal support
            gpu.vendor = gpu.vendor || "unknown";
            gpu.model = gpu.model || "Mac GPU (Metal)";
          }
        }
      } catch {
        // ignore secondary fallback failure
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
   * Parse VRAM string to MB
   */
  parseVRAM(vramStr) {
    if (!vramStr) return null;
    
    const match = vramStr.match(/(\d+\.?\d*)\s*(MiB|GiB|MB|GB)/i);
    if (!match) return null;
    
    const value = parseFloat(match[1]);
    const unit = match[2].toLowerCase();
    
    if (unit === "gib" || unit === "gb") {
      return Math.round(value * 1024);
    }
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
      transcriptionProvider: "local", // Always default to local
      whisperModel: "base",
      localTranscriptionProvider: "whisper", // Default to whisper for CPU fallback
      reasoning: [],
    };

    const { gpu, cpu } = detection;

    // NVIDIA GPU with CUDA - recommend Parakeet
    if (gpu.vendor === "nvidia" && gpu.cuda.available) {
      rec.localTranscriptionProvider = "nvidia";
      rec.parakeetModel = "parakeet-tdt-0.6b-v3";
      rec.reasoning.push("NVIDIA GPU with CUDA detected - Parakeet recommended for GPU acceleration");

      // Check VRAM for model recommendations
      if (gpu.vram && gpu.vram >= 4096) {
        rec.reasoning.push(`GPU has ${gpu.vram}MB VRAM - excellent for local transcription`);
      }
    } else if (gpu.vendor === "apple" || gpu.metal?.available) {
      // Apple Silicon or Intel Mac with Metal - whisper.cpp benefits from Metal acceleration
      rec.localTranscriptionProvider = "whisper";
      rec.whisperModel = "small"; // Metal acceleration can handle larger models
      if (gpu.vendor === "apple") {
        rec.reasoning.push("Apple Silicon detected - using optimized Whisper with Metal acceleration");
      } else {
        rec.reasoning.push("Metal-capable GPU detected - Whisper will use Metal acceleration");
      }
    } else {
      // CPU-only or unsupported GPU
      rec.localTranscriptionProvider = "whisper";
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
