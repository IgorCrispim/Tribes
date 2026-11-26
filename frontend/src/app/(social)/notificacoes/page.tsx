"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { Bell, CheckCheck, Heart, MessageCircle, CalendarDays, ArrowRight, Users } from "lucide-react";
import { Button } from "@/components/ui/button";

type Notification = {
  id: string;
  type: "post_like" | "post_comment" | "event_created" | "event_attendance" | "tribe_invitation";
  contentId: string | null;
  tribeId: string | null;
  tribeName: string | null;
  createdAt: string;
  readAt: string | null;
  actor: { id: string; name: string };
};

const copy = {
  post_like: { verb: "curtiu sua publicação", Icon: Heart },
  post_comment: { verb: "comentou em sua publicação", Icon: MessageCircle },
  event_created: { verb: "publicou um novo evento em", Icon: CalendarDays },
  event_attendance: { verb: "confirmou presença no seu evento em", Icon: CalendarDays },
  tribe_invitation: { verb: "convidou você para a tribo", Icon: Users },
};

function relativeDate(value: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "Data indisponível";
  const seconds = Math.max(0, Math.floor((Date.now() - date.getTime()) / 1000));
  if (seconds < 60) return "Agora";
  if (seconds < 3600) return `Há ${Math.floor(seconds / 60)} min`;
  if (seconds < 86400) return `Há ${Math.floor(seconds / 3600)} h`;
  return date.toLocaleDateString("pt-BR");
}

export default function NotificationsPage() {
  const [items, setItems] = useState<Notification[]>([]);
  const [unreadCount, setUnreadCount] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  const load = useCallback(async () => {
    try {
      const response = await fetch("/api/notifications", { cache: "no-store" });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error ?? "Não foi possível carregar as notificações.");
      setItems(data.items);
      setUnreadCount(data.unreadCount);
      setError("");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Não foi possível carregar as notificações.");
    } finally {
      setLoading(false);
    }
  }, []);

  // Initial fetch synchronizes this page with the notifications API.
  // eslint-disable-next-line react-hooks/set-state-in-effect
  useEffect(() => { void load(); }, [load]);

  async function markRead(id: string) {
    const response = await fetch(`/api/notifications/${id}/read`, { method: "POST" });
    if (!response.ok) return;
    setItems((current) => current.map((item) => item.id === id ? { ...item, readAt: new Date().toISOString() } : item));
    setUnreadCount((count) => Math.max(0, count - 1));
    window.dispatchEvent(new Event("tribes-notifications-updated"));
  }

  async function markAllRead() {
    const response = await fetch("/api/notifications/read-all", { method: "POST" });
    if (!response.ok) return;
    setItems((current) => current.map((item) => ({ ...item, readAt: item.readAt ?? new Date().toISOString() })));
    setUnreadCount(0);
    window.dispatchEvent(new Event("tribes-notifications-updated"));
  }

  return (
    <section className="mx-auto max-w-3xl">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <p className="text-xs font-bold uppercase tracking-[0.18em] text-primary">Atualizações</p>
          <h1 className="mt-2 font-heading text-3xl font-extrabold tracking-tight">Notificações</h1>
          <p className="mt-1 text-sm text-muted-foreground">Acompanhe o que acontece nas suas tribos.</p>
        </div>
        {unreadCount > 0 && <Button variant="outline" size="sm" onClick={() => void markAllRead()}><CheckCheck className="mr-2 size-4" />Marcar todas como lidas</Button>}
      </div>
      {error && <p role="alert" className="mt-6 rounded-xl border border-destructive/30 bg-destructive/5 p-4 text-sm text-destructive">{error}</p>}
      {loading ? (
        <div className="surface-card mt-8 p-8 text-center text-sm text-muted-foreground">Carregando notificações...</div>
      ) : items.length ? (
        <div className="mt-8 divide-y divide-border overflow-hidden rounded-2xl border border-border bg-card">
          {items.map((item) => {
            const { verb, Icon } = copy[item.type];
            const target = item.type === "tribe_invitation" && item.tribeId ? `/tribos/${encodeURIComponent(item.tribeId)}` : item.contentId ? `/publicacoes/${encodeURIComponent(item.contentId)}` : "/feed";
            return (
              <article key={item.id} className={`flex items-center gap-3 p-4 transition-colors sm:gap-4 ${item.readAt ? "" : "bg-primary/[0.045]"}`}>
                <span className="flex size-10 shrink-0 items-center justify-center rounded-xl bg-primary/10 text-primary"><Icon className="size-5" /></span>
                <div className="min-w-0 flex-1">
                  <p className="text-sm"><strong>{item.actor.name}</strong> {verb}{item.tribeName ? <> <strong>{item.tribeName}</strong></> : null}</p>
                  <p className="mt-1 text-xs text-muted-foreground">{relativeDate(item.createdAt)}</p>
                </div>
                {!item.readAt && <span className="size-2 shrink-0 rounded-full bg-primary" aria-label="Não lida" />}
                <Link href={target} onClick={() => { if (!item.readAt) void markRead(item.id); }} aria-label={item.type === "tribe_invitation" ? "Abrir tribo" : "Abrir publicação ou evento"} className="rounded-lg p-2 text-muted-foreground hover:bg-muted hover:text-foreground"><ArrowRight className="size-4" /></Link>
              </article>
            );
          })}
        </div>
      ) : (
        <div className="surface-card mt-8 p-10 text-center">
          <Bell className="mx-auto size-8 text-primary" />
          <h2 className="mt-3 font-heading text-lg font-bold">Tudo em dia</h2>
          <p className="mt-1 text-sm text-muted-foreground">Quando alguém interagir com suas publicações ou criar um evento nas suas tribos, você verá aqui.</p>
        </div>
      )}
    </section>
  );
}
