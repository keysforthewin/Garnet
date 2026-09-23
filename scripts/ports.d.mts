import type { Server } from 'node:net';
export function validPort(value: unknown): number;
export function listenAvailable(server: Server, preferred?: number, host?: string, excluded?: number[]): Promise<number>;
export function availablePort(preferred: number, excluded?: number[]): Promise<number>;
export function appPort(config: { data: string; port?: number }): Promise<number>;
