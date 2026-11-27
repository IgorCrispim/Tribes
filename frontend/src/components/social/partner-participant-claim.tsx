"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { LoaderCircle, TicketCheck } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { apiRequest } from "@/lib/social-types";
import {
  clearParticipantClaimSession,
  getParticipantClaimSession,
  saveParticipantClaimPreview,
  saveParticipantClaimToken,
  type ParticipantClaimPreview,
} from "@/lib/partner-participant-claim-session";

export function PartnerParticipantClaim() {
  const router = useRouter();
  const [preview, setPreview] = useState<ParticipantClaimPreview | null>(null);
  const [linked, setLinked] = useState(false);
  const [joined, setJoined] = useState(false);
  const [password, setPassword] = useState("");
  const [working, setWorking] = useState(false);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const [ready, setReady] = useState(false);

  useEffect(() => {
    let active = true;
    let session = getParticipantClaimSession();
    const fragment = new URLSearchParams(window.location.hash.slice(1));
    const fragmentToken = fragment.get("token");
    if (window.location.hash) window.history.replaceState(null, "", `${window.location.pathname}${window.location.search}`);
    if (fragmentToken && /^[A-Za-z0-9_-]{43}$/.test(fragmentToken)) {
      saveParticipantClaimToken(fragmentToken);
      session = getParticipantClaimSession();
    }
    async function initialize() {
      if (!session?.claimToken && !session?.preview) {
        setError("O link de resgate está incompleto ou expirou. Solicite um novo link à plataforma do evento.");
        setReady(true);
        return;
      }
      const auth = await fetch("/api/auth/me", { cache: "no-store", referrerPolicy: "no-referrer" });
      if (!auth.ok) throw new Error("Não foi possível verificar sua sessão. Tente novamente.");
      const { user } = await auth.json();
      if (!user) {
        router.replace("/entrar?next=%2Fingressos%2Fresgatar");
        return;
      }
      if (session?.preview && Date.parse(session.preview.expiresAt) > Date.now()) {
        if (active) setPreview(session.preview);
      } else if (session?.claimToken) {
        const result = await apiRequest<ParticipantClaimPreview>("/api/partner-participants/preview", {
          method: "POST",
          body: JSON.stringify({ claimToken: session.claimToken }),
          cache: "no-store",
          referrerPolicy: "no-referrer",
        });
        saveParticipantClaimPreview(result);
        if (active) setPreview(result);
      } else {
        clearParticipantClaimSession();
        if (active) setError("A prévia expirou e o segredo de resgate não está mais disponível. Solicite outro link.");
      }
      if (active) setReady(true);
    }
    void initialize().catch(err => {
      if (active) { setError(err instanceof Error ? err.message : "Não foi possível abrir o resgate."); setReady(true); }
    });
    return () => { active = false; };
  }, [router]);

  async function confirmLink() {
    if (!preview || working) return;
    setWorking(true); setError(""); setMessage("");
    try {
      await apiRequest("/api/partner-participants/confirm", {
        method: "POST",
        body: JSON.stringify({ confirmationToken: preview.confirmationToken }),
        cache: "no-store",
        referrerPolicy: "no-referrer",
      });
      clearParticipantClaimSession();
      setLinked(true);
      setMessage("Ingresso vinculado à sua conta. Você ainda não entrou na tribo.");
    } catch (err) { setError(err instanceof Error ? err.message : "Não foi possível vincular o ingresso."); }
    finally { setWorking(false); }
  }

  async function joinTribe() {
    if (!preview || working) return;
    setWorking(true); setError(""); setMessage("");
    try {
      const result = await apiRequest<{ isMember: boolean; joined: boolean }>(
        `/api/me/partner-participants/${encodeURIComponent(preview.participant.id)}/join-tribe`,
        { method: "POST", body: JSON.stringify(preview.socialTribe.isPrivate ? { password } : {}), referrerPolicy: "no-referrer" },
      );
      setJoined(true);
      setMessage(result.joined ? "Você entrou na tribo." : "Você já participa desta tribo.");
      setPassword("");
    } catch (err) { setError(err instanceof Error ? err.message : "Não foi possível entrar na tribo."); }
    finally { setWorking(false); }
  }

  return <main className="mx-auto flex min-h-screen max-w-xl items-center px-4 py-12">
    <section className="w-full space-y-5 rounded-3xl border border-border bg-card p-6 shadow-sm sm:p-8">
      <div className="flex items-center gap-3"><TicketCheck className="size-7 text-primary" /><div><p className="text-sm font-semibold text-primary">Resgate de ingresso</p><h1 className="font-heading text-2xl font-extrabold">Vincule à sua conta Tribes</h1></div></div>
      {!ready && <div role="status" className="flex items-center gap-2 text-sm text-muted-foreground"><LoaderCircle className="size-4 animate-spin" />Validando o resgate...</div>}
      {preview && <>
        <dl className="grid gap-3 rounded-2xl bg-muted/50 p-4 text-sm sm:grid-cols-2">
          <div><dt className="text-muted-foreground">Plataforma</dt><dd className="font-semibold">{preview.partner.name} · {preview.application.name}</dd></div>
          <div><dt className="text-muted-foreground">Evento</dt><dd className="font-semibold">{preview.event.title}</dd></div>
          <div className="sm:col-span-2"><dt className="text-muted-foreground">Tribo associada</dt><dd className="font-semibold">{preview.socialTribe.name}{preview.socialTribe.isPrivate ? " · privada" : ""}</dd></div>
        </dl>
        {!linked ? <>
          <p className="text-sm text-muted-foreground">Ao confirmar, este ingresso ficará associado somente à sua conta Tribes. Isso não compartilha seu nome ou e-mail com a plataforma e não adiciona você à tribo.</p>
          <Button type="button" disabled={!ready || working} onClick={() => void confirmLink()}>{working && <LoaderCircle className="size-4 animate-spin" />}Confirmar vínculo do ingresso</Button>
        </> : <>
          <p className="text-sm text-muted-foreground">Para entrar na comunidade, confirme essa ação separadamente. As regras de acesso da tribo continuam valendo.</p>
          {preview.socialTribe.isPrivate && <div className="space-y-1.5"><Label htmlFor="participant-tribe-password">Senha da tribo privada</Label><Input id="participant-tribe-password" type="password" autoComplete="current-password" maxLength={128} value={password} onChange={event => setPassword(event.target.value)} /></div>}
          {!joined && <Button type="button" disabled={working || (preview.socialTribe.isPrivate && !password)} onClick={() => void joinTribe()}>{working && <LoaderCircle className="size-4 animate-spin" />}Entrar na tribo</Button>}
        </>}
      </>}
      {message && <p role="status" className="text-sm text-primary">{message}</p>}
      {error && <div className="space-y-3"><p role="alert" className="rounded-xl bg-destructive/10 p-3 text-sm text-destructive">{error}</p><Button variant="outline" type="button" onClick={() => router.push("/perfil")}>Ir para minha conta</Button></div>}
      {ready && !preview && !error && <p className="text-sm text-muted-foreground">Abra novamente o link seguro fornecido pela plataforma do evento.</p>}
    </section>
  </main>;
}
