import React, { useEffect, useState } from "react";
import { Button } from "./ui/button";
import { Minus, Square, X, Copy } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "./ui/dialog";

/**
 * Window control buttons for Linux and Windows platforms
 * Provides minimize, maximize/restore, and close functionality
 * macOS uses native window controls so this component is not rendered there
 */
export default function WindowControls() {
  const [isMaximized, setIsMaximized] = useState(false);
  const [showCloseConfirm, setShowCloseConfirm] = useState(false);

  useEffect(() => {
    let mounted = true;

    // Sync maximized state with main process
    const syncIsMaximized = async () => {
      try {
        const maximized = await window.electronAPI?.windowIsMaximized?.();
        if (mounted) {
          setIsMaximized(!!maximized);
        }
      } catch {
        // Silently handle if API not available
      }
    };

    // Initial sync
    syncIsMaximized();

    // Poll for changes (window can be maximized via double-click on title bar, etc.)
    const intervalId = setInterval(syncIsMaximized, 1000);

    return () => {
      mounted = false;
      clearInterval(intervalId);
    };
  }, []);

  const handleMinimize = async () => {
    try {
      await window.electronAPI?.windowMinimize?.();
    } catch {
      // Silently handle if API not available
    }
  };

  const handleMaximize = async () => {
    try {
      await window.electronAPI?.windowMaximize?.();
      // Update state after toggle
      const maximized = await window.electronAPI?.windowIsMaximized?.();
      setIsMaximized(!!maximized);
    } catch {
      // Silently handle if API not available
    }
  };

  const handleClose = async () => {
    // Show confirmation dialog instead of closing directly
    setShowCloseConfirm(true);
  };

  const handleMinimizeToTray = async () => {
    try {
      await window.electronAPI?.windowClose?.();
      setShowCloseConfirm(false);
    } catch {
      // Silently handle if API not available
    }
  };

  const handleQuitCompletely = async () => {
    try {
      await window.electronAPI?.appQuit?.();
      setShowCloseConfirm(false);
    } catch {
      // Silently handle if API not available
    }
  };

  return (
    <>
      <div className="flex items-center gap-1 pointer-events-auto">
        <Button
          variant="ghost"
          size="icon"
          onClick={handleMinimize}
          title="Minimize"
          className="h-8 w-8"
        >
          <Minus size={14} />
        </Button>
        <Button
          variant="ghost"
          size="icon"
          onClick={handleMaximize}
          title={isMaximized ? "Restore" : "Maximize"}
          className="h-8 w-8"
        >
          {isMaximized ? <Copy size={14} /> : <Square size={12} />}
        </Button>
        <Button
          variant="ghost"
          size="icon"
          onClick={handleClose}
          className="h-8 w-8 hover:text-destructive hover:bg-destructive/10"
          title="Close"
        >
          <X size={14} />
        </Button>
      </div>

      <Dialog open={showCloseConfirm} onOpenChange={setShowCloseConfirm}>
        <DialogContent className="sm:max-w-[425px]">
          <DialogHeader>
            <DialogTitle>Close Privoca?</DialogTitle>
            <DialogDescription>
              Privoca will continue running in the system tray. Would you like to minimize to
              tray or quit completely?
            </DialogDescription>
          </DialogHeader>
          <DialogFooter className="gap-2 sm:gap-0">
            <Button variant="outline" onClick={() => setShowCloseConfirm(false)}>
              Cancel
            </Button>
            <Button variant="default" onClick={handleMinimizeToTray}>
              Minimize to Tray
            </Button>
            <Button variant="destructive" onClick={handleQuitCompletely}>
              Quit Completely
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
