export const typingRate = 240;
export const animationBudgetMs = 2000;
export const highlightMs = 1200;
export function typingDuration(graphemes: number) { return graphemes * 1000 / typingRate; }
export function canAnimate(remainingMs: number, graphemes: number) { return Math.max(0, remainingMs) + typingDuration(graphemes) <= animationBudgetMs; }
export interface AgentEditEvent {
  type: 'agent-edit'; id: string; version: string; signature: string; textChanged: boolean;
  from: Record<string, any>; to: Record<string, any>;
}
