export interface User { id: string; username: string; admin: boolean; mustChangePassword: boolean }
export interface DocMeta { id: string; title: string; updatedAt: number; createdAt: number; deletedAt: number | null; revision: number; mirrorRevision: number; filename?: string; purgedAt?: number }
export interface Settings { idleMs: number; maxSaveMs: number; trashDays: number; revisionLimit: number; httpsAddress: string; agent: { provider: 'claude' | 'codex'; claudePath: string; codexPath: string; model: string; cwd: string; timeoutMinutes: number } }
export const defaults: Settings = { idleMs: 750, maxSaveMs: 5000, trashDays: 30, revisionLimit: 100, httpsAddress: '', agent: { provider: 'claude', claudePath: 'claude', codexPath: 'codex', model: '', cwd: '', timeoutMinutes: 30 } };
