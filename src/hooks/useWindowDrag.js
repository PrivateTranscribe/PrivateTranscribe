import { useState, useEffect, useRef } from "react";

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

  const handleMouseUp = () => {
    if (!isDraggingRef.current) {
      return;
    }

    setIsDragging(false);
    isDraggingRef.current = false;
    window.electronAPI.stopWindowDrag?.();
  };

  const handleClick = (e) => {
    // Prevent any click actions - use hotkey only
    e.preventDefault();
  };

  // Set up global mouse up listener when dragging
  useEffect(() => {
    if (isDragging) {
      const handleGlobalMouseUp = () => handleMouseUp();

      document.addEventListener("mouseup", handleGlobalMouseUp);

      return () => {
        document.removeEventListener("mouseup", handleGlobalMouseUp);
      };
    }
  }, [isDragging]);

  return {
    isDragging,
    handleMouseDown,
    handleMouseUp,
    handleClick,
  };
};
