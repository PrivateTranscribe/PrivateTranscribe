import { useState, useCallback, useEffect } from "react";

const LOCAL_STORAGE_CHANGE_EVENT = "privatetranscribe-local-storage-change";

type LocalStorageChangeDetail = {
  key: string;
  value: string | null;
};

export function useLocalStorage<T>(
  key: string,
  defaultValue: T,
  options?: {
    serialize?: (value: T) => string;
    deserialize?: (value: string) => T;
  }
) {
  const serialize = options?.serialize || JSON.stringify;
  const deserialize = options?.deserialize || JSON.parse;

  const dispatchLocalStorageChange = useCallback(
    (value: string | null) => {
      if (typeof window === "undefined") return;

      const dispatch = () => {
        window.dispatchEvent(
          new CustomEvent<LocalStorageChangeDetail>(LOCAL_STORAGE_CHANGE_EVENT, {
            detail: { key, value },
          })
        );
      };

      if (typeof window.queueMicrotask === "function") {
        window.queueMicrotask(dispatch);
      } else {
        window.setTimeout(dispatch, 0);
      }
    },
    [key]
  );

  const [state, setState] = useState<T>(() => {
    try {
      const item = localStorage.getItem(key);
      if (item === null) {
        // Persist the default so direct localStorage.getItem() reads
        // (e.g. in audioManager, PromptStudio) see the intended value.
        localStorage.setItem(key, serialize(defaultValue));
        return defaultValue;
      }
      return deserialize(item);
    } catch {
      return defaultValue;
    }
  });

  const setValue = useCallback(
    (value: T | ((prevState: T) => T)) => {
      setState((currentState) => {
        try {
          const valueToStore = value instanceof Function ? value(currentState) : value;
          const serializedValue = serialize(valueToStore);
          localStorage.setItem(key, serializedValue);
          dispatchLocalStorageChange(serializedValue);
          return valueToStore;
        } catch (error) {
          console.error(`Error setting localStorage key "${key}":`, error);
          return currentState;
        }
      });
    },
    [key, serialize, dispatchLocalStorageChange]
  );

  const remove = useCallback(() => {
    try {
      localStorage.removeItem(key);
      setState(defaultValue);
      dispatchLocalStorageChange(null);
    } catch (error) {
      console.error(`Error removing localStorage key "${key}":`, error);
    }
  }, [key, defaultValue, dispatchLocalStorageChange]);

  useEffect(() => {
    if (typeof window === "undefined") return;

    const parseAndSet = (rawValue: string | null) => {
      try {
        setState(rawValue === null ? defaultValue : deserialize(rawValue));
      } catch {
        setState(defaultValue);
      }
    };

    const handleSameWindowChange = (event: Event) => {
      const customEvent = event as CustomEvent<LocalStorageChangeDetail>;
      if (customEvent.detail?.key !== key) return;
      parseAndSet(customEvent.detail.value);
    };

    const handleStorageChange = (event: StorageEvent) => {
      if (event.storageArea !== localStorage || event.key !== key) return;
      parseAndSet(event.newValue);
    };

    window.addEventListener(LOCAL_STORAGE_CHANGE_EVENT, handleSameWindowChange);
    window.addEventListener("storage", handleStorageChange);

    return () => {
      window.removeEventListener(LOCAL_STORAGE_CHANGE_EVENT, handleSameWindowChange);
      window.removeEventListener("storage", handleStorageChange);
    };
  }, [key, defaultValue, deserialize]);

  return [state, setValue, remove] as const;
}
