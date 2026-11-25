"use client";

import { useEffect, useState } from "react";
import { LoaderCircle, MonitorSmartphone, Shield, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { apiRequest } from "@/lib/social-types";

type UserSession = {
  id: string;
  created_at: string;
  last_seen_at: string;
  expires_at: string;
  is_current: boolean;
};

function formatSessionDate(value: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "Data indisponível";
  return new Intl.DateTimeFormat("pt-BR", { dateStyle: "medium", timeStyle: "short" }).format(date);
}

export function SessionManager() {
  const [sessions, setSessions] = useState<UserSession[]>([]);
  const [loading, setLoading] = useState(true);
  const [busyId, setBusyId] = useState("");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [reloadKey, setReloadKey] = useState(0);

  useEffect(() => {
    let active = true;
    apiRequest<{ sessions: UserSession[] }>("/api/auth/sessions")
      .then(({ sessions: result }) => { if (active) setSessions(result); })
      .catch((loadError) => {
        if (active) setError(loadError instanceof Error ? loadError.message : "Não foi possível carregar as sessões.");
      })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [reloadKey]);

  async function revokeSession(session: UserSession) {
    setBusyId(session.id);
    setError("");
    setNotice("");
    try {
      await apiRequest(`/api/auth/sessions/${session.id}`, { method: "DELETE" });
      setSessions((current) => current.filter((item) => item.id !== session.id));
      setNotice("Sessão encerrada.");
    } catch (revokeError) {
      setError(revokeError instanceof Error ? revokeError.message : "Não foi possível encerrar a sessão.");
    } finally {
      setBusyId("");
    }
  }

  async function revokeOthers() {
    setBusyId("others");
    setError("");
    setNotice("");
    try {
      const result = await apiRequest<{ revokedCount: number }>("/api/auth/sessions/revoke-others", { method: "POST" });
      setSessions((current) => current.filter((session) => session.is_current));
      setNotice(result.revokedCount === 1 ? "Uma outra sessão foi encerrada." : `${result.revokedCount} outras sessões foram encerradas.`);
    } catch (revokeError) {
      setError(revokeError instanceof Error ? revokeError.message : "Não foi possível encerrar as outras sessões.");
    } finally {
      setBusyId("");
    }
  }

  const otherSessions = sessions.filter((session) => !session.is_current);

  function retryLoading() {
    setLoading(true);
    setError("");
    setReloadKey((key) => key + 1);
  }

  return (
    <section className="mt-6 space-y-4 rounded-3xl border border-border bg-card p-5 shadow-xs sm:p-8">
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <p className="flex items-center gap-2 text-sm font-semibold text-primary"><Shield className="size-4" />Segurança da conta</p>
          <h2 className="mt-2 font-heading text-xl font-extrabold">Sessões ativas</h2>
          <p className="mt-1 text-sm text-muted-foreground">Confira os acessos à sua conta e encerre sessões que não reconhecer.</p>
        </div>
        <Button type="button" variant="outline" size="sm" disabled={loading || otherSessions.length === 0 || busyId !== ""} onClick={() => void revokeOthers()}>
          {busyId === "others" ? <LoaderCircle className="size-4 animate-spin" /> : <Trash2 className="size-4" />}
          Encerrar outras sessões
        </Button>
      </header>

      {loading && <p role="status" className="flex items-center gap-2 text-sm text-muted-foreground"><LoaderCircle className="size-4 animate-spin" />Carregando sessões...</p>}
      {error && <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl bg-destructive/10 px-3 py-2 text-sm text-destructive" role="alert">
        <span>{error}</span>
        <Button type="button" variant="outline" size="sm" onClick={retryLoading}>Tentar novamente</Button>
      </div>}
      {notice && <p role="status" className="text-sm font-medium text-primary">{notice}</p>}

      {!loading && !error && sessions.length === 0 && <p className="text-sm text-muted-foreground">Nenhuma sessão ativa foi encontrada.</p>}
      {!loading && !error && sessions.length > 0 && <ul className="space-y-3">
        {sessions.map((session) => (
          <li key={session.id} className="flex flex-col gap-3 rounded-2xl border border-border p-4 sm:flex-row sm:items-center sm:justify-between">
            <div className="flex items-start gap-3">
              <MonitorSmartphone className="mt-0.5 size-5 shrink-0 text-muted-foreground" />
              <div>
                <p className="text-sm font-semibold">{session.is_current ? "Este dispositivo · sessão atual" : "Outra sessão"}</p>
                <p className="mt-1 text-xs text-muted-foreground">Última atividade: {formatSessionDate(session.last_seen_at)}</p>
                <p className="text-xs text-muted-foreground">Iniciada: {formatSessionDate(session.created_at)}</p>
              </div>
            </div>
            {!session.is_current && <Button type="button" variant="ghost" size="sm" disabled={busyId !== ""} onClick={() => void revokeSession(session)} className="text-destructive hover:text-destructive">
              {busyId === session.id ? <LoaderCircle className="size-4 animate-spin" /> : <Trash2 className="size-4" />}
              Encerrar
            </Button>}
          </li>
        ))}
      </ul>}
    </section>
  );
}
