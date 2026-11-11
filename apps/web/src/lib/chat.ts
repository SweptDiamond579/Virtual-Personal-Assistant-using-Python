"use client";

import type { ChatMessage, RunSummary } from "@jarvis/protocol";
import { get, post } from "./api";
import { useJarvis } from "./store";

export async function sendChat(text: string): Promise<RunSummary> {
  const s = useJarvis.getState();
  const res = await post<{ run: RunSummary; message: ChatMessage }>("/api/chat", {
    text,
    conversation_id: s.conversationId,
  });
  const st = useJarvis.getState();
  const convId = res.message.conversation_id;
  const isNew = st.conversationId !== convId;
  st.setConversation(convId, mergeMessages(isNew ? [] : st.messages, [res.message]));
  st.setRuns([res.run]);
  if (isNew) {
    // Realtime events for a brand-new conversation can arrive before this POST resolves
    // (before we knew its id). Reconcile with the persisted history so nothing is lost.
    void get<ChatMessage[]>(`/api/conversations/${convId}/messages`).then((persisted) => {
      const now = useJarvis.getState();
      if (now.conversationId === convId) now.setConversation(convId, mergeMessages(now.messages, persisted));
    });
  }
  return res.run;
}

export function mergeMessages(a: ChatMessage[], b: ChatMessage[]): ChatMessage[] {
  const byId = new Map<string, ChatMessage>();
  for (const m of [...a, ...b]) byId.set(m.id, m);
  return [...byId.values()].sort((x, y) => x.created_at.localeCompare(y.created_at));
}

export async function openConversation(id: string | null) {
  if (!id) {
    useJarvis.getState().setConversation(null, []);
    return;
  }
  const messages = await get<ChatMessage[]>(`/api/conversations/${id}/messages`);
  useJarvis.getState().setConversation(id, messages);
}

export interface DirectCommand {
  tool: string;
  args: Record<string, unknown>;
  label: string;
}

/** Parses slash commands that run tools directly (no AI model involved). */
export function parseDirectCommand(input: string): DirectCommand | null {
  const q = input.trim();
  let m: RegExpMatchArray | null;
  if (/^\/time\b/i.test(q)) return { tool: "get_current_time", args: {}, label: "Current time" };
  if ((m = q.match(/^\/calc\s+(.+)/i))) return { tool: "calculate", args: { expression: m[1] }, label: `Calculate ${m[1]}` };
  if ((m = q.match(/^\/note\s+([^|]+)(?:\|(.*))?$/i)))
    return { tool: "notes_create", args: { title: m[1]!.trim(), body: (m[2] ?? "").trim() }, label: `Create note “${m[1]!.trim()}”` };
  if ((m = q.match(/^\/remind\s+(\d+)\s*m(?:in(?:utes?)?)?\s+(.+)/i)))
    return { tool: "reminder_create", args: { in_minutes: Number(m[1]), text: m[2] }, label: `Remind in ${m[1]} min: ${m[2]}` };
  if ((m = q.match(/^\/repo\s+([\w.-]+\/[\w.-]+)/i)))
    return { tool: "github_repo_overview", args: { repo: m[1] }, label: `GitHub overview of ${m[1]}` };
  if ((m = q.match(/^\/weather\s+(.+)/i))) return { tool: "weather_current", args: { location: m[1] }, label: `Weather in ${m[1]}` };
  if ((m = q.match(/^\/fetch\s+(https?:\/\/\S+)/i))) return { tool: "web_fetch", args: { url: m[1] }, label: `Fetch ${m[1]}` };
  return null;
}

export async function runDirectCommand(cmd: DirectCommand): Promise<RunSummary> {
  const res = await post<{ run: RunSummary }>("/api/commands", { tool: cmd.tool, args: cmd.args });
  useJarvis.getState().setRuns([res.run]);
  return res.run;
}

export const SLASH_HELP = [
  ["/time", "Current time"],
  ["/calc 2^10 / 4", "Exact arithmetic"],
  ["/note Title | body", "Save a note"],
  ["/remind 15m stretch", "One-off reminder"],
  ["/repo owner/name", "GitHub repository overview"],
  ["/weather London", "Current weather"],
  ["/fetch https://…", "Fetch a page (allow-list applies)"],
] as const;
