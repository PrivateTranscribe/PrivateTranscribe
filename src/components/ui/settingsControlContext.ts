import { createContext } from "react";

// SettingsRow supplies its existing visible text to controls without adding
// markup or duplicating labels. Controls with explicit names keep those names.
export const SettingsControlContext = createContext<{
  labelId: string;
  descriptionId?: string;
} | null>(null);
