/**
 * Global test setup for Vitest
 *
 * This file is run before each test file and provides:
 * - Mock setup for Electron APIs
 * - Common test utilities
 * - Environment configuration
 */

import { vi, beforeEach, afterEach } from "vitest";

// Mock localStorage for browser-dependent code
const localStorageMock = (() => {
  let store: Record<string, string> = {};
  return {
    getItem: (key: string) => store[key] ?? null,
    setItem: (key: string, value: string) => {
      store[key] = value;
    },
    removeItem: (key: string) => {
      delete store[key];
    },
    clear: () => {
      store = {};
    },
    get length() {
      return Object.keys(store).length;
    },
    key: (index: number) => Object.keys(store)[index] ?? null,
  };
})();

// Set up global mocks
beforeEach(() => {
  // Reset localStorage mock before each test
  localStorageMock.clear();

  // Mock window object for tests that need it
  if (typeof global.window === "undefined") {
    (global as any).window = {
      localStorage: localStorageMock,
      electronAPI: undefined,
    };
  } else {
    (global.window as any).localStorage = localStorageMock;
  }
});

afterEach(() => {
  vi.clearAllMocks();
  vi.restoreAllMocks();
});

// Export utilities for use in tests
export { localStorageMock };

// Type augmentation for global test utilities
declare global {
  // eslint-disable-next-line no-var
  var window: {
    localStorage: typeof localStorageMock;
    electronAPI?: any;
  };
}
