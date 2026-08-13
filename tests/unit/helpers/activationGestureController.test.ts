import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const ActivationGestureController = require("../../../src/helpers/activationGestureController");

describe("ActivationGestureController", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  function createController(mode: "tap" | "push" | "tapHold") {
    const callbacks = {
      onTap: vi.fn(),
      onHoldStart: vi.fn(),
      onHoldEnd: vi.fn(),
    };
    const controller = new ActivationGestureController({ mode, ...callbacks });
    return { controller, callbacks };
  }

  it("fires one tap only after a short press is released", () => {
    const { controller, callbacks } = createController("tap");

    expect(controller.keyDown()).toBe(true);
    expect(controller.keyDown()).toBe(false);
    vi.advanceTimersByTime(149);
    expect(callbacks.onTap).not.toHaveBeenCalled();

    controller.keyUp();

    expect(callbacks.onTap).toHaveBeenCalledTimes(1);
    expect(callbacks.onHoldStart).not.toHaveBeenCalled();
    expect(callbacks.onHoldEnd).not.toHaveBeenCalled();
  });

  it("ignores a held key in tap mode", () => {
    const { controller, callbacks } = createController("tap");

    controller.keyDown();
    vi.advanceTimersByTime(150);
    controller.keyDown();
    controller.keyUp();

    expect(callbacks.onTap).not.toHaveBeenCalled();
    expect(callbacks.onHoldStart).not.toHaveBeenCalled();
    expect(callbacks.onHoldEnd).not.toHaveBeenCalled();
  });

  it("ignores a short press in hold mode", () => {
    const { controller, callbacks } = createController("push");

    controller.keyDown();
    vi.advanceTimersByTime(149);
    controller.keyUp();
    vi.runAllTimers();

    expect(callbacks.onTap).not.toHaveBeenCalled();
    expect(callbacks.onHoldStart).not.toHaveBeenCalled();
    expect(callbacks.onHoldEnd).not.toHaveBeenCalled();
  });

  it("fires exactly one hold start and end in hold mode", () => {
    const { controller, callbacks } = createController("push");

    controller.keyDown();
    vi.advanceTimersByTime(150);
    controller.keyDown();

    expect(callbacks.onHoldStart).toHaveBeenCalledTimes(1);

    controller.keyUp();
    controller.keyUp();

    expect(callbacks.onHoldEnd).toHaveBeenCalledTimes(1);
    expect(callbacks.onTap).not.toHaveBeenCalled();
  });

  it("supports both a short tap and a separate hold in Both mode", () => {
    const { controller, callbacks } = createController("tapHold");

    controller.keyDown();
    controller.keyUp();
    expect(callbacks.onTap).toHaveBeenCalledTimes(1);

    controller.keyDown();
    vi.advanceTimersByTime(150);
    controller.keyUp();

    expect(callbacks.onTap).toHaveBeenCalledTimes(1);
    expect(callbacks.onHoldStart).toHaveBeenCalledTimes(1);
    expect(callbacks.onHoldEnd).toHaveBeenCalledTimes(1);
  });

  it("ends an active hold when the gesture is cancelled", () => {
    const { controller, callbacks } = createController("push");

    controller.keyDown();
    vi.advanceTimersByTime(150);
    controller.cancel();

    expect(callbacks.onHoldStart).toHaveBeenCalledTimes(1);
    expect(callbacks.onHoldEnd).toHaveBeenCalledTimes(1);
    expect(controller.keyUp()).toBe(false);
  });
});
