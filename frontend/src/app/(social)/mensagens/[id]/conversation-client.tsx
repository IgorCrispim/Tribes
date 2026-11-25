"use client";

import { useEffect, useRef, useState, type FormEvent } from "react";
import Link from "next/link";
import { useParams } from "next/navigation";
import { ArrowLeft, LoaderCircle, MessageCircle, Send } from "lucide-react";
import { UserAvatar } from "@/components/social/user-avatar";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { apiRequest } from "@/lib/social-types";

type DirectMessage = {
  id: string;
  body: string;
  createdAt: string;
  isMine: boolean;
  sender: { id: string; name: string; avatarUrl: string | null };
};

type DirectConversation = { id: string; peer: { id: string; name: string; avatarUrl: string | null } };
const POLL_INTERVAL_MS = 3_000;
const messageTime = new Intl.DateTimeFormat("pt-BR", { dateStyle: "short", timeStyle: "short" });

export default function DirectConversationClient() {
  const { id } = useParams<{ id: string }>();
  const [conversation, setConversation] = useState<DirectConversation | null>(null);
  const [messages, setMessages] = useState<DirectMessage[]>([]);
  const [body, setBody] = useState("");
  const [loading, setLoading] = useState(true);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState("");
  const messagesRef = useRef<HTMLDivElement>(null);
  const revisionRef = useRef(0);
  const readEventSentRef = useRef(false);

  useEffect(() => {
    let active = true;
    let timeout: ReturnType<typeof setTimeout> | undefined;
    let fetching = false;

    const refresh = async () => {
      if (fetching) return;
      fetching = true;
      const revision = revisionRef.current;
      try {
        const [conversationResult, messageResult] = await Promise.all([
          apiRequest<{ conversation: DirectConversation }>(`/api/dm/conversations/${encodeURIComponent(id)}`, { cache: "no-store" }),
          apiRequest<{ messages: DirectMessage[] }>(`/api/dm/conversations/${encodeURIComponent(id)}/messages`, { cache: "no-store" }),
        ]);
        if (active && revision === revisionRef.current) {
          setConversation(conversationResult.conversation);
          setMessages(messageResult.messages);
          setError("");
          if (!readEventSentRef.current) {
            readEventSentRef.current = true;
            window.dispatchEvent(new Event("tribes-dm-updated"));
          }
        }
      } catch (loadError) {
        if (active) setError(loadError instanceof Error ? loadError.message : "Não foi possível carregar a conversa.");
      } finally {
        fetching = false;
        if (active) {
          setLoading(false);
          timeout = setTimeout(() => void refresh(), POLL_INTERVAL_MS);
        }
      }
    };

    void refresh();
    return () => {
      active = false;
      if (timeout) clearTimeout(timeout);
    };
  }, [id]);

  const latestMessageId = messages[messages.length - 1]?.id;
  useEffect(() => {
    const container = messagesRef.current;
    if (container) container.scrollTop = container.scrollHeight;
  }, [latestMessageId]);

  async function sendMessage(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const trimmed = body.trim();
    if (!trimmed || sending) return;
    setSending(true);
    setError("");
    revisionRef.current += 1;
    try {
      const { message } = await apiRequest<{ message: DirectMessage }>(`/api/dm/conversations/${encodeURIComponent(id)}/messages`, {
        method: "POST",
        body: JSON.stringify({ body: trimmed }),
      });
      setMessages((current) => [...current.filter((item) => item.id !== message.id), message].sort((left, right) =>
        new Date(left.createdAt).getTime() - new Date(right.createdAt).getTime() || left.id.localeCompare(right.id)
      ));
      setBody("");
    } catch (sendError) {
      setError(sendError instanceof Error ? sendError.message : "Não foi possível enviar a mensagem.");
    } finally {
      setSending(false);
    }
  }

  return (
    <main className="mx-auto max-w-3xl">
      <Link href="/mensagens" className="mb-4 inline-flex min-h-10 items-center gap-2 rounded-xl px-3 text-sm font-semibold text-muted-foreground transition-colors hover:bg-muted hover:text-foreground">
        <ArrowLeft className="size-4" />Todas as conversas
      </Link>
      <section className="overflow-hidden rounded-3xl border border-border bg-card shadow-xs" aria-label="Conversa direta">
        <header className="flex items-center gap-3 border-b border-border px-4 py-3 sm:px-6">
          {conversation ? <UserAvatar name={conversation.peer.name} avatarUrl={conversation.peer.avatarUrl} className="size-10" /> : <span className="flex size-10 items-center justify-center rounded-full bg-primary/10 text-primary"><MessageCircle className="size-5" /></span>}
          <div className="min-w-0">
            <h1 className="truncate font-heading text-lg font-bold">{conversation?.peer.name ?? (loading ? "Carregando conversa..." : "Conversa")}</h1>
            <p className="text-xs text-muted-foreground">Mensagem direta</p>
          </div>
        </header>

        {error && <p role="alert" className="mx-4 mt-4 rounded-xl border border-destructive/30 bg-destructive/10 p-3 text-sm text-destructive sm:mx-6">{error}</p>}

        <div ref={messagesRef} className="flex max-h-[min(58vh,38rem)] min-h-72 flex-col gap-3 overflow-y-auto bg-muted/20 p-3 sm:p-5" aria-live="polite" aria-label="Mensagens da conversa">
          {loading ? <div className="flex flex-1 items-center justify-center"><LoaderCircle className="size-6 animate-spin text-primary" aria-label="Carregando mensagens" /></div> : messages.length ? messages.map((message) => (
            <article key={message.id} className={`flex max-w-[88%] items-end gap-2 ${message.isMine ? "ml-auto flex-row-reverse" : "mr-auto"}`}>
              {!message.isMine && <UserAvatar name={message.sender.name} avatarUrl={message.sender.avatarUrl} className="size-7 shrink-0" />}
              <div className={`min-w-0 rounded-2xl px-3 py-2 shadow-xs ${message.isMine ? "rounded-br-md bg-primary text-primary-foreground" : "rounded-bl-md bg-card"}`}>
                <p className="whitespace-pre-wrap break-words text-sm leading-relaxed [overflow-wrap:anywhere]">{message.body}</p>
                <time className={`mt-1 block text-right text-[10px] ${message.isMine ? "text-primary-foreground/70" : "text-muted-foreground"}`} dateTime={message.createdAt}>{messageTime.format(new Date(message.createdAt))}</time>
              </div>
            </article>
          )) : <div className="flex flex-1 flex-col items-center justify-center text-center">
            <MessageCircle className="size-8 text-primary/70" />
            <p className="mt-3 text-sm font-semibold">Comece a conversa</p>
            <p className="mt-1 text-xs text-muted-foreground">Envie uma mensagem para {conversation?.peer.name ?? "esta pessoa"}.</p>
          </div>}
        </div>

        <form className="border-t border-border p-3 sm:p-4" onSubmit={sendMessage}>
          <label htmlFor="direct-message-body" className="sr-only">Escreva uma mensagem</label>
          <div className="flex items-end gap-2">
            <Textarea
              id="direct-message-body"
              value={body}
              onChange={(event) => setBody(event.target.value)}
              placeholder="Escreva uma mensagem..."
              maxLength={1000}
              rows={2}
              className="min-h-12 max-h-36 resize-y rounded-2xl bg-background"
              disabled={sending || loading || !conversation}
              onKeyDown={(event) => {
                if (event.key !== "Enter" || event.shiftKey || event.nativeEvent.isComposing || event.repeat) return;
                event.preventDefault();
                event.currentTarget.form?.requestSubmit();
              }}
            />
            <Button type="submit" size="icon" aria-label="Enviar mensagem" className="size-11 shrink-0 rounded-xl" disabled={sending || loading || !body.trim() || !conversation}>
              {sending ? <LoaderCircle className="size-4 animate-spin" /> : <Send className="size-4" />}
            </Button>
          </div>
          <p className="mt-1 text-right text-[10px] text-muted-foreground">{body.length}/1000 · Enter para enviar</p>
        </form>
      </section>
    </main>
  );
}
