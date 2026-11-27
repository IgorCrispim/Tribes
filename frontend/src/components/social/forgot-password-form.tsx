"use client";

import { useState } from "react";
import Link from "next/link";
import { LoaderCircle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { ThemeToggle } from "@/components/theme/theme-toggle";
import { TribesMark } from "@/components/tribes/tribes-mark";

export function ForgotPasswordForm() {
  const [email, setEmail] = useState("");
  const [error, setError] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [requested, setRequested] = useState(false);

  async function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError("");
    setSubmitting(true);
    try {
      const response = await fetch("/api/auth/password-reset", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email }),
      });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error ?? "Não foi possível enviar o link.");
      setRequested(true);
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
        <Link href="/" className="flex items-center gap-2 font-heading text-lg font-extrabold">
          <TribesMark alt="" className="size-9" />
          tribes
        </Link>
        <h1 className="mt-8 font-heading text-2xl font-extrabold">
          {requested ? "Confira seu e-mail" : "Esqueceu sua senha?"}
        </h1>
        <p className="mt-2 text-sm text-muted-foreground">
          {requested
            ? "Se este e-mail estiver cadastrado, enviaremos um link assim que houver disponibilidade. Ele será válido por 30 minutos após o envio."
            : "Informe o e-mail da sua conta e enviaremos um link para criar uma nova senha."}
        </p>
        {!requested && <form onSubmit={handleSubmit} className="mt-6 space-y-4">
          <div className="space-y-1.5">
            <Label htmlFor="email">E-mail</Label>
            <Input id="email" type="email" value={email} onChange={(event) => setEmail(event.target.value)} autoComplete="email" maxLength={254} required />
          </div>
          {error && <p role="alert" className="rounded-xl border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive">{error}</p>}
          <Button type="submit" disabled={submitting} className="h-11 w-full rounded-xl font-semibold">
            {submitting && <LoaderCircle className="size-4 animate-spin" />}
            {submitting ? "Aguarde..." : "Enviar link de redefinição"}
          </Button>
        </form>}
        <p className="mt-5 text-center text-sm text-muted-foreground">
          <Link href="/entrar" className="font-semibold text-primary hover:underline">Voltar para entrar</Link>
        </p>
      </section>
    </main>
  );
}
