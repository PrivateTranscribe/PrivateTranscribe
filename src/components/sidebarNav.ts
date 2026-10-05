import {
  LayoutDashboard,
  Clock,
  Upload,
  Mic,
  BookOpen,
  Brain,
  MessagesSquare,
  AudioLines,
  Zap,
} from "lucide-react";
import type { PageId } from "./AppSidebar";
import { isBetaFeature } from "../utils/betaFeatures";
import { isExperimentalPage } from "../utils/experimentalFeatures";

export interface NavItem {
  id: PageId;
  label: string;
  icon: typeof LayoutDashboard;
}

export interface NavGroup {
  label?: string;
  items: NavItem[];
}

/**
 * Every feature the app has. Beta pages are listed only while beta features are
 * on, except AI Enhancement: its coding prompt shortcuts are not beta. Converse
 * and the Action Engine also wait for experimental features.
 */
export const navGroups: NavGroup[] = [
  {
    items: [
      { id: "home", label: "Home", icon: LayoutDashboard },
      { id: "history", label: "History", icon: Clock },
      { id: "transcribe", label: "Transcribe File", icon: Upload },
    ],
  },
  {
    label: "SPEECH",
    items: [
      { id: "dictation", label: "Dictation", icon: Mic },
      { id: "dictionary", label: "Dictionary", icon: BookOpen },
      { id: "read-aloud", label: "Read Aloud", icon: AudioLines },
    ],
  },
  {
    label: "INTELLIGENCE",
    items: [
      { id: "ai-enhancement", label: "AI Enhancement", icon: Brain },
      { id: "converse", label: "Converse", icon: MessagesSquare },
    ],
  },
  {
    label: "ADVANCED",
    items: [{ id: "action-engine", label: "Action Engine", icon: Zap }],
  },
];

export function visibleNavGroups(
  groups: NavGroup[],
  { betaOn, experimentalOn }: { betaOn: boolean; experimentalOn: boolean }
): NavGroup[] {
  return groups
    .map((group) => ({
      ...group,
      items: group.items.filter(
        (item) =>
          (experimentalOn || !isExperimentalPage(item.id)) &&
          (item.id === "ai-enhancement" || betaOn || !isBetaFeature(item.id))
      ),
    }))
    .filter((group) => group.items.length > 0);
}
