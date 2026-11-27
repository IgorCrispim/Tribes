"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { ArrowLeft, LoaderCircle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { PasswordInput } from "@/components/ui/password-input";
import { Label } from "@/components/ui/label";
import { ThemeToggle } from "@/components/theme/theme-toggle";
import { TribesMark } from "@/components/tribes/tribes-mark";
import { trackMvpEvent } from "@/lib/mvp-tracker";
import { getInvitationToken } from "@/lib/invitation-token";
import { getParticipantClaimSession, onSocialSessionReady } from "@/lib/partner-participant-claim-session";

export function AuthForm({ mode }: { mode: "login" | "register" }) {
  const router = useRouter();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [registrationMessage, setRegistrationMessage] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [registrationRequested, setRegistrationRequested] = useState(false);
  const registering = mode === "register";

  useEffect(() => {
    if (registering) void trackMvpEvent({ event: "page_view", pagePath: "/cadastro" });
  }, [registering]);

  useEffect(() => {
    if (!getParticipantClaimSession()) return;
    return onSocialSessionReady(() => {
      router.replace("/ingressos/resgatar");
      router.refresh();
    });
  }, [router]);

  async function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError("");
    setSubmitting(true);
    try {
      if (registering) void trackMvpEvent({ event: "registration_start" });
      const response = await fetch(`/api/auth/${registering ? "register" : "login"}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(registering ? { email, invitationToken: getInvitationToken() ?? undefined } : { email, password }),
      });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error ?? "Não foi possível entrar.");
      if (registering) {
        setRegistrationMessage(result.message ?? "Se este e-mail puder ser cadastrado, enviaremos um link para continuar.");
        setRegistrationRequested(true);
        return;
      }
      const params = new URLSearchParams(window.location.search);
      const next = params.get("next");
      router.replace(next?.startsWith("/") && !next.startsWith("//")
        ? next
        : getParticipantClaimSession() ? "/ingressos/resgatar"
          : getInvitationToken() ? "/convite" : "/feed");
    } catch (submitError) {
      setError(submitError instanceof Error ? submitError.message : "Tente novamente.");
    } finally {
      setSubmitting(false);
    }
  }


  return (
    <main className="relative flex min-h-screen items-center justify-center px-4 py-10">
      <ThemeToggle className="absolute right-4 top-4" />
      <section className="w-full max-w-md rounded-3xl border border-border bg-card p-6 shadow-lg sm:p-8">
        <Link href="/" className="mb-6 inline-flex items-center gap-2 text-sm font-semibold text-muted-foreground transition-colors hover:text-foreground">
          <ArrowLeft className="size-4" />
          Voltar
        </Link>
        <Link href="/" className="flex items-center gap-2 font-heading text-lg font-extrabold">
          <TribesMark alt="" className="size-9" />
          tribes
        </Link>
        <h1 className="mt-8 font-heading text-2xl font-extrabold">
          {registering ? registrationRequested ? "Confira seu e-mail" : "Crie sua conta" : "Entre na sua conta"}
        </h1>
        <p className="mt-2 text-sm text-muted-foreground">
          {registering
            ? registrationRequested
              ? registrationMessage
              : "Informe seu e-mail e enviaremos um link para criar sua senha."
            : "Suas tribos e conversas estão esperando por você."}
        </p>
        {registrationRequested && getParticipantClaimSession() && <p role="status" className="mt-3 rounded-xl bg-muted/60 px-3 py-2 text-sm text-muted-foreground">
          Depois de confirmar o cadastro no e-mail, volte para esta aba. O resgate será retomado automaticamente.
        </p>}
        {!registrationRequested && <form onSubmit={handleSubmit} className="mt-6 space-y-4">
          <div className="space-y-1.5">
            <Label htmlFor="email">E-mail</Label>
            <Input id="email" type="email" value={email} onChange={(event) => setEmail(event.target.value)} autoComplete="email" maxLength={254} required />
          </div>
          {!registering && <div className="space-y-1.5">
            <Label htmlFor="password">Senha</Label>
            <PasswordInput id="password" value={password} onChange={(event) => setPassword(event.target.value)} minLength={1} maxLength={128} autoComplete="current-password" required />
            <div className="text-right">
              <Link href="/esqueci-senha" className="text-sm font-semibold text-primary hover:underline">
                Esqueci minha senha
              </Link>
            </div>
          </div>}
          {error && <p role="alert" className="rounded-xl border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive">{error}</p>}
          <Button type="submit" disabled={submitting} className="h-11 w-full rounded-xl font-semibold">
            {submitting && <LoaderCircle className="size-4 animate-spin" />}
            {submitting ? "Aguarde..." : registering ? "Enviar link" : "Entrar"}
          </Button>
        </form>}
        <p className="mt-5 text-center text-sm text-muted-foreground">
          {registering ? "Já tem uma conta? " : "Ainda não tem uma conta? "}
          <Link href={registering ? "/entrar" : "/cadastro"} onClick={event => {
            const next = new URLSearchParams(window.location.search).get("next") ?? "";
            if (next.startsWith("/") && !next.startsWith("//")) {
              event.preventDefault();
              router.push(`${registering ? "/entrar" : "/cadastro"}?next=${encodeURIComponent(next)}`);
            }
          }} className="font-semibold text-primary hover:underline">
            {registering ? "Entrar" : "Cadastre-se"}
          </Link>
        </p>
      </section>
    </main>
  );
}
