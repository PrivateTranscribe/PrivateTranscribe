import { useState, useEffect, useRef, useCallback } from "react";

export const useWindowDrag = () => {
  const [isDragging, setIsDragging] = useState(false);
  const isDraggingRef = useRef(false);

  useEffect(() => {
    isDraggingRef.current = isDragging;
  }, [isDragging]);

  const handleMouseDown = (e) => {
    if (e.button !== 0 || isDraggingRef.current) {
      return;
    }

    setIsDragging(true);
    isDraggingRef.current = true;
    window.electronAPI.startWindowDrag?.();
    e.preventDefault();
  };

  const resetLocalDragState = useCallback(() => {
    setIsDragging(false);
    isDraggingRef.current = false;
  }, []);

  const stopDragging = useCallback(() => {
    if (!isDraggingRef.current) {
      return;
    }

    resetLocalDragState();
    window.electronAPI.stopWindowDrag?.();
  }, [resetLocalDragState]);

  const handleMouseUp = () => {
    stopDragging();
  };

  const handleClick = (e) => {
    // Prevent any click actions - use hotkey only
    e.preventDefault();
  };

  // Set up global release/cancel listeners while dragging. Laptop touchpads and
  // borderless/fullscreen apps can deliver the release outside the tiny overlay
  // document; listening only on document.mouseup leaves the native drag interval
  // running, which looks like the overlay slowly travelling downward after release.
  useEffect(() => {
    if (isDragging) {
      const handleGlobalStop = () => stopDragging();
      const handleVisibilityChange = () => {
        if (document.visibilityState === "hidden") {
          stopDragging();
        }
      };

      document.addEventListener("mouseup", handleGlobalStop, true);
      window.addEventListener("mouseup", handleGlobalStop, true);
      window.addEventListener("pointerup", handleGlobalStop, true);
      window.addEventListener("pointercancel", handleGlobalStop, true);
      window.addEventListener("blur", handleGlobalStop, true);
      document.addEventListener("visibilitychange", handleVisibilityChange, true);

      return () => {
        document.removeEventListener("mouseup", handleGlobalStop, true);
        window.removeEventListener("mouseup", handleGlobalStop, true);
        window.removeEventListener("pointerup", handleGlobalStop, true);
        window.removeEventListener("pointercancel", handleGlobalStop, true);
        window.removeEventListener("blur", handleGlobalStop, true);
        document.removeEventListener("visibilitychange", handleVisibilityChange, true);
      };
    }
  }, [isDragging, stopDragging]);

  useEffect(() => {
    const unsubscribe = window.electronAPI?.onWindowDragReset?.(() => {
      resetLocalDragState();
    });
    return () => unsubscribe?.();
  }, [resetLocalDragState]);

  return {
    isDragging,
    handleMouseDown,
    handleMouseUp,
    handleClick,
  };
};
