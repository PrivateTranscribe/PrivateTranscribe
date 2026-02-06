import { useState, useEffect } from "react";

export const useHotkey = () => {
  const [hotkey, setHotkey] = useState("`");

  useEffect(() => {
    // Load hotkey from localStorage on mount
    const savedHotkey = localStorage.getItem("dictationKey");
    if (savedHotkey) {
      setHotkey(savedHotkey);
    }
  }, []);

  return {
    hotkey,
    setHotkey,
  };
};
