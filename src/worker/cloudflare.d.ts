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

interface R2Object {
  size: number;
  checksums: { sha256?: ArrayBuffer };
}
interface R2Bucket {
  put(key: string, value: ReadableStream | Uint8Array, options?: { sha256?: string }): Promise<R2Object | null>;
  get(key: string, options?: { range: { offset: number; length: number } }): Promise<(R2Object & { body: ReadableStream }) | null>;
  head(key: string): Promise<R2Object | null>;
  delete(key: string): Promise<void>;
}
declare class FixedLengthStream extends TransformStream<Uint8Array, Uint8Array> {
  constructor(length: number);
}

interface DurableObjectNamespace<T> {
  idFromName(name: string): unknown;
  get(id: unknown): { fetch(req: Request): Promise<Response> } & { [K in keyof T]: T[K] };
}
