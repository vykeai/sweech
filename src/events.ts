/**
 * Typed event bus for internal sweech events
 */

import { EventEmitter } from 'node:events';

export interface SweechEvents {
  limit_reached: { account: string; window: '5h' | '7d'; timestamp: string };
  capacity_available: { account: string; window: '5h' | '7d'; timestamp: string };
  session_start: { account: string; pid: number; timestamp: string };
  session_end: { account: string; pid: number; timestamp: string };
  token_refreshed: { account: string; expiresAt: string };
  token_expired: { account: string };
  account_added: { account: string };
  account_removed: { account: string };
  server_started: { port: number };
  server_stopped: {};
}

export type SweechEventName = keyof SweechEvents;

export class SweechEventBus extends EventEmitter {
  emit<K extends SweechEventName>(event: K, data: SweechEvents[K]): boolean {
    return super.emit(event, data);
  }

  on<K extends SweechEventName>(event: K, listener: (data: SweechEvents[K]) => void): this {
    return super.on(event, listener);
  }

  once<K extends SweechEventName>(event: K, listener: (data: SweechEvents[K]) => void): this {
    return super.once(event, listener);
  }

  off<K extends SweechEventName>(event: K, listener: (data: SweechEvents[K]) => void): this {
    return super.off(event, listener);
  }
}

/** Singleton event bus for the sweech process */
export const sweechEvents = new SweechEventBus();

/**
 * Convenience helper — emit a typed event on the singleton bus.
 */
export function emitEvent<K extends SweechEventName>(name: K, data: SweechEvents[K]): boolean {
  return sweechEvents.emit(name, data);
}
