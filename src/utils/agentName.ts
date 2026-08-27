import { useEffect, useState } from "react";

const AGENT_NAME_KEY = "agentName";
const DEFAULT_AGENT_NAME = "PrivateTranscribe";

/**
 * Fired whenever the stored agent name changes.
 *
 * The name is read by several components at once — the name field, the
 * trigger-phrase examples, and Prompt Studio's rendered system prompt all sit
 * on the AI Enhancement page together. Without this, each `useAgentName()` call
 * kept its own snapshot from mount, so renaming the assistant updated the field
 * you typed in and left the prompt below it showing the old name until the page
 * was remounted.
 */
const AGENT_NAME_EVENT = "privatetranscribe-agent-name-changed";

export const getAgentName = (): string => {
  return localStorage.getItem(AGENT_NAME_KEY) || DEFAULT_AGENT_NAME;
};

export const setAgentName = (name: string): void => {
  localStorage.setItem(AGENT_NAME_KEY, name);
  try {
    window.dispatchEvent(new CustomEvent(AGENT_NAME_EVENT, { detail: name }));
  } catch {
    // No renderer event target (e.g. a non-DOM test environment).
  }
};

/** Only sets agent name if one isn't already stored (preserves existing user preferences) */
export const setAgentNameIfEmpty = (name: string): void => {
  if (!localStorage.getItem(AGENT_NAME_KEY)) {
    setAgentName(name);
  }
};

export const clearAgentName = (): void => {
  localStorage.removeItem(AGENT_NAME_KEY);
  try {
    window.dispatchEvent(new CustomEvent(AGENT_NAME_EVENT, { detail: null }));
  } catch {
    // No renderer event target.
  }
};

export const useAgentName = () => {
  const [agentName, setAgentNameState] = useState<string>(getAgentName);

  useEffect(() => {
    const handler = () => setAgentNameState(getAgentName());
    window.addEventListener(AGENT_NAME_EVENT, handler);
    return () => window.removeEventListener(AGENT_NAME_EVENT, handler);
  }, []);

  const updateAgentName = (name: string) => {
    setAgentName(name);
    setAgentNameState(name);
  };

  return { agentName, setAgentName: updateAgentName };
};
