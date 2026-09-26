// The assistant's API: /api/chat/* on Docket, proxied to docket-chat (its CHAT_API.md is the contract).
import { HttpError, enc, request, unreachable } from "./api";
import { getMe } from "./auth";

export interface ChatTool {
  callId?: string;
  name: string;
  summary: string;
  status: string; // running | done | error | canceled
}

export interface ChatMessage {
  id: string;
  role: "user" | "assistant";
  content: string;
  createdAt: string;
  tools?: ChatTool[];
  status?: string; // assistant: complete | stopped | error
}

export interface ChatAction {
  actionId: string;
  tool: string;
  args: Record<string, unknown>;
  summary: string;
  expiresAt: string;
}

export interface ChatConversation {
  id: string;
  title: string;
  createdAt: string;
  updatedAt: string;
}

export type ChatEvent =
  | { event: "conversation"; data: { id: string; title: string; created: boolean } }
  | { event: "delta"; data: { text: string } }
  | { event: "tool"; data: ChatTool & { callId: string } }
  | { event: "confirm"; data: ChatAction }
  | { event: "title"; data: { title: string } }
  | { event: "done"; data: { messageId: string } }
  | { event: "error"; data: { message: string; code: string } };

/** An error the service answered with before streaming: `code` says which (busy, full, rate_limited, …). */
export class ChatError extends HttpError {
  code: string;
  constructor(message: string, status: number, code: string) {
    super(message, status);
    this.code = code;
  }
}

export const chatApi = {
  list: (after?: string) =>
    request<{ conversations: ChatConversation[]; nextCursor: string | null }>("GET", `/api/chat/conversations${after ? `?after=${enc(after)}` : ""}`),
  get: (id: string) =>
    request<ChatConversation & { messages: ChatMessage[]; pendingAction: ChatAction | null }>("GET", `/api/chat/conversations/${enc(id)}`),
  rename: (id: string, title: string) => request<ChatConversation>("PATCH", `/api/chat/conversations/${enc(id)}`, { title }),
  remove: (id: string) => request<void>("DELETE", `/api/chat/conversations/${enc(id)}`),
  cancel: (actionId: string) => request<{ status: string }>("POST", `/api/chat/actions/${enc(actionId)}/cancel`),
  send: (body: { conversationId?: string; message: string }, signal: AbortSignal, on: (e: ChatEvent) => void) => stream("/api/chat", body, signal, on),
  confirm: (actionId: string, signal: AbortSignal, on: (e: ChatEvent) => void) => stream(`/api/chat/actions/${enc(actionId)}/confirm`, undefined, signal, on),
};

/** POSTs and reads the server-sent events as they arrive. Errors before the stream starts throw a ChatError. */
async function stream(path: string, body: unknown, signal: AbortSignal, on: (e: ChatEvent) => void): Promise<void> {
  const headers: Record<string, string> = { "x-docket-user": getMe().user.username };
  if (body !== undefined) headers["content-type"] = "application/json";
  const res = await fetch(path, { method: "POST", headers, body: body === undefined ? undefined : JSON.stringify(body), signal }).catch((e) => {
    throw signal.aborted ? e : unreachable();
  });
  if (!res.headers.get("content-type")?.includes("text/event-stream")) {
    const data = (await res.json().catch(() => null)) as { error?: string; code?: string } | null;
    // Signed out, or another tab switched account: the app's usual 401 handling takes it from here.
    if (res.status === 401) await request("GET", "/api/me").catch(() => {});
    throw new ChatError(data?.error || `${res.status} ${res.statusText}`, res.status, data?.code ?? "");
  }
  const reader = res.body!.pipeThrough(new TextDecoderStream()).getReader();
  let buffer = "";
  for (;;) {
    const { value, done } = await reader.read().catch((e) => {
      throw signal.aborted ? e : unreachable();
    });
    if (done) return;
    buffer += value;
    for (let end = buffer.indexOf("\n\n"); end >= 0; end = buffer.indexOf("\n\n")) {
      const block = buffer.slice(0, end);
      buffer = buffer.slice(end + 2);
      let event = "";
      let data = "";
      for (const line of block.split("\n")) {
        if (line.startsWith("event: ")) event = line.slice(7);
        else if (line.startsWith("data: ")) data += line.slice(6);
      }
      if (event && data) on({ event, data: JSON.parse(data) } as ChatEvent); // ": ping" comments have neither
    }
  }
}
