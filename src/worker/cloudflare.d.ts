// The few Workers runtime types src/worker uses (the full set clashes with Bun's).
declare module "cloudflare:workers" {
  export abstract class DurableObject<Env = unknown> {
    protected ctx: DurableObjectState;
    protected env: Env;
    constructor(ctx: DurableObjectState, env: Env);
  }
}

interface DurableObjectState {
  storage: import("../server/store.ts").SqlStorage & { getAlarm(): Promise<number | null>; setAlarm(at: number): Promise<void> };
  waitUntil(promise: Promise<unknown>): void;
  acceptWebSocket(ws: WebSocket): void;
  getWebSockets(): WebSocket[];
}

interface WebSocket {
  serializeAttachment(value: unknown): void;
  deserializeAttachment(): any;
}
declare const WebSocketPair: { new (): { 0: WebSocket; 1: WebSocket } };
interface ResponseInit {
  webSocket?: WebSocket;
}

interface DurableObjectNamespace<T> {
  idFromName(name: string): unknown;
  get(id: unknown): { fetch(req: Request): Promise<Response> } & { [K in keyof T]: T[K] };
}
