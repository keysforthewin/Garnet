export type AgentProvider = 'claude' | 'codex';
export interface ModelCatalog { models: { id: string; name: string; description?: string }[]; error?: string }
export interface User { id: string; username: string; admin: boolean; mustChangePassword: boolean }
export interface DocMeta { id: string; title: string; updatedAt: number; createdAt: number; deletedAt: number | null; revision: number; mirrorRevision: number; filename?: string; purgedAt?: number }
export interface Settings { idleMs: number; maxSaveMs: number; trashDays: number; revisionLimit: number; httpsAddress: string; agent: { provider: 'claude' | 'codex'; claudePath: string; codexPath: string; claudeModel: string; codexModel: string; cwd: string; timeoutMinutes: number } }
export const defaults: Settings = { idleMs: 750, maxSaveMs: 5000, trashDays: 30, revisionLimit: 100, httpsAddress: '', agent: { provider: 'claude', claudePath: 'claude', codexPath: 'codex', claudeModel: '', codexModel: '', cwd: '', timeoutMinutes: 30 } };

export function normalizeAgentSettings(agent: Settings['agent'] & { model?: string }): Settings['agent'] {
  const { model, ...rest } = agent;
  return { ...defaults.agent, ...rest, claudeModel: agent.claudeModel ?? (agent.provider === 'claude' ? model || '' : ''), codexModel: agent.codexModel ?? (agent.provider === 'codex' ? model || '' : '') };
}
