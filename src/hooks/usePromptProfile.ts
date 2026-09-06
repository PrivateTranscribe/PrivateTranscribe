import { useEffect, useReducer } from "react";
import {
  PROMPT_CHANGE_EVENT,
  getPromptProfile,
  getProfileTemplate,
} from "../config/promptProfiles";

export function usePromptProfile() {
  const [, refresh] = useReducer((value: number) => value + 1, 0);
  useEffect(() => {
    window.addEventListener(PROMPT_CHANGE_EVENT, refresh);
    window.addEventListener("storage", refresh);
    return () => {
      window.removeEventListener(PROMPT_CHANGE_EVENT, refresh);
      window.removeEventListener("storage", refresh);
    };
  }, []);
  return {
    profile: getPromptProfile(),
    currentTemplate: getProfileTemplate("current"),
    experimentalTemplate: getProfileTemplate("experimental"),
  };
}
