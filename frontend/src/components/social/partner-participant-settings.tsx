"use client";

import { useEffect, useState } from "react";
import { LoaderCircle, TicketCheck, Unlink } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { apiRequest } from "@/lib/social-types";

type PartnerParticipant = {
  id: string;
  event: { externalEventId: string; title: string };
  partner: { name: string; applicationName: string };
  socialTribeName: string;
  status: "active" | "cancelled" | "event_cancelled";
  socialLinkActive: boolean;
  isMember: boolean;
  claimedAt: string;
};

export function PartnerParticipantSettings() {
  const [participants, setParticipants] = useState<PartnerParticipant[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [workingId, setWorkingId] = useState("");
  const [passwords, setPasswords] = useState<Record<string, string>>({});
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");

  useEffect(() => {
    let active = true;
    apiRequest<{ participants: PartnerParticipant[] }>("/api/me/partner-participants", { cache: "no-store" })
      .then(result => { if (active) setParticipants(result.participants); })
      .catch(loadError => { if (active) setError(loadError instanceof Error ? loadError.message : "Não foi possível carregar os ingressos vinculados."); })
      .finally(() => { if (active) setLoaded(true); });
    return () => { active = false; };
  }, []);

  async function join(item: PartnerParticipant) {
    setWorkingId(item.id); setError(""); setMessage("");
    try {
      const result = await apiRequest<{ isMember: boolean; joined: boolean }>(
        `/api/me/partner-participants/${encodeURIComponent(item.id)}/join-tribe`,
        { method: "POST", body: JSON.stringify(passwords[item.id] ? { password: passwords[item.id] } : {}) },
      );
      setParticipants(current => current.map(participant => participant.id === item.id ? { ...participant, isMember: true } : participant));
      setPasswords(current => ({ ...current, [item.id]: "" }));
      setMessage(result.joined ? `Você entrou em ${item.socialTribeName}.` : `Você já participa de ${item.socialTribeName}.`);
    } catch (joinError) { setError(joinError instanceof Error ? joinError.message : "Não foi possível entrar na tribo."); }
    finally { setWorkingId(""); }
  }

  async function unlink(item: PartnerParticipant) {
    if (!window.confirm(`Desvincular o ingresso de “${item.event.title}” da sua conta? Isso não fará você sair da tribo.`)) return;
    setWorkingId(item.id); setError(""); setMessage("");
    try {
      await apiRequest(`/api/me/partner-participants/${encodeURIComponent(item.id)}`, { method: "DELETE" });
      setParticipants(current => current.filter(participant => participant.id !== item.id));
      setMessage("Ingresso desvinculado. Sua participação em qualquer tribo não foi alterada.");
    } catch (unlinkError) { setError(unlinkError instanceof Error ? unlinkError.message : "Não foi possível desvincular o ingresso."); }
    finally { setWorkingId(""); }
  }

  return <section className="space-y-4 rounded-3xl border border-border bg-card p-5 shadow-xs sm:p-8">
    <div className="flex items-center gap-3"><TicketCheck className="size-5 text-primary" /><div><h2 className="font-heading text-xl font-bold">Ingressos vinculados</h2><p className="text-sm text-muted-foreground">Somente você pode consultar ou desvincular os ingressos associados à sua conta.</p></div></div>
    {!loaded && <div role="status" className="flex items-center gap-2 text-sm text-muted-foreground"><LoaderCircle className="size-4 animate-spin" />Carregando...</div>}
    {loaded && participants.length === 0 && <p className="text-sm text-muted-foreground">Você ainda não vinculou ingressos à sua conta.</p>}
    {participants.map(item => <article key={item.id} className="space-y-3 rounded-2xl border border-border p-4">
      <div><p className="font-semibold">{item.event.title}</p><p className="text-sm text-muted-foreground">{item.partner.name} · {item.partner.applicationName}</p><p className="text-sm text-muted-foreground">Tribo associada: {item.socialTribeName}</p>
        {item.status !== "active" && <p className="mt-1 text-sm text-amber-700">{item.status === "event_cancelled" ? "Evento cancelado" : "Ingresso cancelado"}; esse ingresso não autoriza uma nova entrada.</p>}
        {!item.socialLinkActive && item.status === "active" && <p className="mt-1 text-sm text-amber-700">O vínculo da tribo foi revogado; esse ingresso não autoriza uma nova entrada.</p>}
        {item.isMember && <p className="mt-1 text-sm text-primary">Você já participa desta tribo.</p>}
      </div>
      {!item.isMember && item.status === "active" && item.socialLinkActive && <div className="space-y-2">
        <p className="text-sm text-muted-foreground">Entrar na tribo é uma ação separada e segue as regras atuais de acesso.</p>
        <div className="flex flex-wrap items-end gap-2">
          <div className="min-w-48 flex-1 space-y-1.5"><Label htmlFor={`participant-password-${item.id}`}>Senha da tribo, se necessária</Label><Input id={`participant-password-${item.id}`} type="password" autoComplete="current-password" maxLength={128} value={passwords[item.id] ?? ""} onChange={event => setPasswords(current => ({ ...current, [item.id]: event.target.value }))} /></div>
          <Button type="button" disabled={workingId === item.id} onClick={() => void join(item)}>{workingId === item.id && <LoaderCircle className="size-4 animate-spin" />}Entrar na tribo</Button>
        </div>
      </div>}
      <Button type="button" size="sm" variant="outline" disabled={workingId === item.id} onClick={() => void unlink(item)}><Unlink className="size-4" />Desvincular ingresso</Button>
    </article>)}
    {message && <p role="status" className="text-sm text-primary">{message}</p>}
    {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
  </section>;
}
