"use client";

import { useCallback, useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { apiRequest } from "@/lib/social-types";

type Invitation = { id: string; tribeId: string; tribeName: string; inviterName: string; expiresAt: string };
type SentInvitation = { id: string; email: string; expiresAt: string };

export function TribeInvitations({ tribeId, onAccepted }: { tribeId: string; onAccepted: () => void }) {
  const [received, setReceived] = useState<Invitation[]>([]);
  const [sent, setSent] = useState<SentInvitation[]>([]);
  const [canInvite, setCanInvite] = useState(false);
  const [email, setEmail] = useState("");
  const [working, setWorking] = useState(false);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");

  const load = useCallback(async () => {
    try {
      const response = await fetch(`/api/invitations?tribeId=${encodeURIComponent(tribeId)}`, { cache: "no-store" });
      if (response.status === 401) { setCanInvite(false); return; }
      if (!response.ok) throw new Error();
      const result = await response.json() as { invitations: Invitation[] };
      setReceived(result.invitations);
    } catch { setError("Não foi possível carregar seus convites."); }
    try {
      const response = await fetch(`/api/tribes/${tribeId}/invitations`, { cache: "no-store" });
      if (response.status === 401 || response.status === 404) { setCanInvite(false); setSent([]); return; }
      if (!response.ok) throw new Error();
      const result = await response.json() as { invitations: SentInvitation[] };
      setCanInvite(true);
      setSent(result.invitations);
    } catch { setError("Não foi possível carregar os convites pendentes."); }
  }, [tribeId]);
  // Load invitation state and the current authorization from the API.
  // eslint-disable-next-line react-hooks/set-state-in-effect
  useEffect(() => { void load(); }, [load]);

  async function respond(invitation: Invitation, action: "accept" | "decline") {
    if (working) return;
    setWorking(true); setError(""); setMessage("");
    try {
      await apiRequest(`/api/invitations/${invitation.id}/${action}`, { method: "POST" });
      setReceived(current => current.filter(item => item.id !== invitation.id));
      if (action === "accept") { onAccepted(); setMessage("Você entrou na tribo."); }
      else setMessage("Convite recusado.");
    } catch (err) { setError(err instanceof Error ? err.message : "Não foi possível responder ao convite."); }
    finally { setWorking(false); }
  }
  async function send(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (working) return;
    setWorking(true); setError(""); setMessage("");
    try {
      const result = await apiRequest<{ message: string }>(`/api/tribes/${tribeId}/invitations`, { method: "POST", body: JSON.stringify({ email }) });
      setEmail(""); setMessage(result.message); await load();
    } catch (err) { setError(err instanceof Error ? err.message : "Não foi possível enviar o convite."); }
    finally { setWorking(false); }
  }
  async function cancel(id: string) {
    if (working) return;
    setWorking(true); setError(""); setMessage("");
    try { await apiRequest(`/api/invitations/${id}`, { method: "DELETE" }); setSent(current => current.filter(item => item.id !== id)); setMessage("Convite cancelado."); }
    catch (err) { setError(err instanceof Error ? err.message : "Não foi possível cancelar o convite."); }
    finally { setWorking(false); }
  }

  if (!received.length && !canInvite && !message && !error) return null;
  return <section className="space-y-4 rounded-3xl border border-border bg-card p-5 sm:p-7">
    {received.map(invitation => <div key={invitation.id} className="space-y-3">
      <h2 className="font-heading text-lg font-bold">Convite para {invitation.tribeName}</h2>
      <p className="text-sm text-muted-foreground"><strong>{invitation.inviterName}</strong> convidou você. Deseja entrar nesta tribo?</p>
      <div className="flex flex-wrap gap-2"><Button disabled={working} onClick={() => void respond(invitation, "accept")}>Aceitar convite</Button><Button disabled={working} variant="outline" onClick={() => void respond(invitation, "decline")}>Recusar convite</Button></div>
    </div>)}
    {canInvite && <><h2 className="font-heading text-lg font-bold">Convidar membros</h2><form onSubmit={event => void send(event)} className="flex flex-col gap-3 sm:flex-row sm:items-end"><div className="flex-1 space-y-1.5"><Label htmlFor="invite-email">E-mail</Label><Input id="invite-email" type="email" maxLength={254} value={email} onChange={event => setEmail(event.target.value)} required /></div><Button type="submit" disabled={working}>Enviar convite</Button></form>
      {sent.length > 0 && <div className="space-y-2"><h3 className="text-sm font-semibold">Convites pendentes</h3>{sent.map(invitation => <div key={invitation.id} className="flex flex-wrap items-center justify-between gap-2 text-sm"><span className="break-all">{invitation.email}</span><Button type="button" size="sm" variant="outline" disabled={working} onClick={() => void cancel(invitation.id)}>Cancelar</Button></div>)}</div>}
    </>}
    {message && <p role="status" className="text-sm text-primary">{message}</p>}
    {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
  </section>;
}
