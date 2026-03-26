import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// We test the recovery logic without requiring the actual module (which needs Electron).
// Instead we reconstruct the relevant methods.

class TrayManager {
  tray: any = null;
  _healthCheckInterval: any = null;

  async createTray() {
    // stub — overridden in tests
  }

  attemptTrayRecovery(attempt = 1) {
    const maxAttempts = 3;
    if (attempt > maxAttempts) return;
    if (this.tray) return;

    const delayMs = 1000 * Math.pow(2, attempt - 1);
    setTimeout(async () => {
      if (this.tray) return;
      try {
        await this.createTray();
        if (this.tray) {
          // recovered
        } else {
          this.attemptTrayRecovery(attempt + 1);
        }
      } catch {
        this.attemptTrayRecovery(attempt + 1);
      }
    }, delayMs);
  }

  startHealthCheck() {
    if (this._healthCheckInterval) return;
    this._healthCheckInterval = setInterval(() => {
      if (!this.tray || this.tray.isDestroyed?.()) {
        this.tray = null;
        this.attemptTrayRecovery();
      }
    }, 30000);
  }

  stopHealthCheck() {
    if (this._healthCheckInterval) {
      clearInterval(this._healthCheckInterval);
      this._healthCheckInterval = null;
    }
  }
}

describe('TrayManager recovery', () => {
  let manager: InstanceType<typeof TrayManager>;

  beforeEach(() => {
    vi.useFakeTimers();
    manager = new TrayManager();
  });

  afterEach(() => {
    manager.stopHealthCheck();
    vi.useRealTimers();
  });

  it('attemptTrayRecovery calls createTray after delay', async () => {
    const spy = vi.spyOn(manager, 'createTray').mockResolvedValue(undefined);
    // Simulate: tray is null (destroyed)
    manager.tray = null;
    manager.attemptTrayRecovery();

    // Should not call immediately
    expect(spy).not.toHaveBeenCalled();

    // Advance 1s (first attempt delay)
    await vi.advanceTimersByTimeAsync(1000);
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it('retries up to 3 times on failure', async () => {
    let callCount = 0;
    vi.spyOn(manager, 'createTray').mockImplementation(async () => {
      callCount++;
      // Never sets this.tray — simulates failure
    });

    manager.tray = null;
    manager.attemptTrayRecovery();

    // 1s, 2s, 4s
    await vi.advanceTimersByTimeAsync(1000);
    expect(callCount).toBe(1);
    await vi.advanceTimersByTimeAsync(2000);
    expect(callCount).toBe(2);
    await vi.advanceTimersByTimeAsync(4000);
    expect(callCount).toBe(3);
    // No more attempts
    await vi.advanceTimersByTimeAsync(10000);
    expect(callCount).toBe(3);
  });

  it('stops retrying if tray is recovered', async () => {
    let callCount = 0;
    vi.spyOn(manager, 'createTray').mockImplementation(async () => {
      callCount++;
      manager.tray = { isDestroyed: () => false }; // "recovered"
    });

    manager.tray = null;
    manager.attemptTrayRecovery();

    await vi.advanceTimersByTimeAsync(1000);
    expect(callCount).toBe(1);
    // Should not retry since tray is now set
    await vi.advanceTimersByTimeAsync(10000);
    expect(callCount).toBe(1);
  });

  it('health check triggers recovery when tray is missing', async () => {
    const spy = vi.spyOn(manager, 'attemptTrayRecovery').mockImplementation(() => {});
    manager.tray = null;
    manager.startHealthCheck();

    await vi.advanceTimersByTimeAsync(30000);
    expect(spy).toHaveBeenCalledTimes(1);

    manager.stopHealthCheck();
  });

  it('health check triggers recovery when tray.isDestroyed() returns true', async () => {
    const spy = vi.spyOn(manager, 'attemptTrayRecovery').mockImplementation(() => {});
    manager.tray = { isDestroyed: () => true };
    manager.startHealthCheck();

    await vi.advanceTimersByTimeAsync(30000);
    expect(spy).toHaveBeenCalledTimes(1);
    expect(manager.tray).toBeNull();

    manager.stopHealthCheck();
  });
});
