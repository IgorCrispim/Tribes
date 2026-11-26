"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { LoaderCircle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { clearInvitationToken, getInvitationToken, setInvitationToken } from "@/lib/invitation-token";

export default function InvitationPage() {
  const router = useRouter();
  const [error, setError] = useState("");
  useEffect(() => {
    let active = true;
    const token = new URLSearchParams(window.location.hash.slice(1)).get("token") ?? getInvitationToken();
    if (window.location.hash) window.history.replaceState(null, "", window.location.pathname);
    if (token) setInvitationToken(token);
    async function openInvitation() {
      if (!token) throw new Error("O link do convite está incompleto.");
      const session = await fetch("/api/auth/me", { cache: "no-store" });
      if (!session.ok) throw new Error("Não foi possível verificar sua sessão. Tente novamente.");
      const { user } = await session.json();
      if (!active) return;
      if (!user) { router.replace("/cadastro"); return; }
      const response = await fetch("/api/invitations/resolve", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ token }) });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error ?? "Não foi possível abrir o convite.");
      if (active) { clearInvitationToken(); router.replace(`/tribos/${encodeURIComponent(result.tribeId)}`); }
    }
    void openInvitation().catch((err) => { if (active) setError(err instanceof Error ? err.message : "Não foi possível abrir o convite."); });
    return () => { active = false; };
  }, [router]);

  return <main className="mx-auto flex min-h-screen max-w-md flex-col items-center justify-center gap-4 px-6 text-center">
    {error ? <><p role="alert" className="text-sm text-destructive">{error}</p><p className="text-sm text-muted-foreground">Entre com a conta do e-mail convidado ou solicite um novo convite.</p><Button variant="outline" nativeButton={false} render={<Link href="/feed" />}>Voltar</Button></> : <><LoaderCircle className="size-6 animate-spin text-primary" /><p role="status" className="text-sm text-muted-foreground">Abrindo convite...</p></>}
  </main>;
}
