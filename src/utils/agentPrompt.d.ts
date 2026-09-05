export interface AgentPromptResult {
  text: string;
  send: boolean;
  changed: boolean;
}
export interface AgentPromptRule {
  id: string;
  label: string;
  order: number;
}
export const AGENT_PROMPT_RULES: readonly AgentPromptRule[];
export function applySpokenKeys(text: string): string;
export function cleanAgentPrompt(transcript?: unknown): AgentPromptResult;
export function extractSendCommand(text: string): { text: string; send: boolean };
export function formatCodeReferences(text: string): string;
export function tidyPunctuation(text: string): string;
