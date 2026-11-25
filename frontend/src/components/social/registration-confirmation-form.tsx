"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { LoaderCircle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { PasswordInput } from "@/components/ui/password-input";
import { Label } from "@/components/ui/label";
import { PASSWORD_HINT, PASSWORD_MAX_LENGTH, PASSWORD_MIN_LENGTH, passwordPolicyError } from "@/lib/password-policy";
import { ThemeToggle } from "@/components/theme/theme-toggle";

export function RegistrationConfirmationForm({ token }: { token: string }) {
  const router = useRouter();
  const [name, setName] = useState("");
  const [password, setPassword] = useState("");
  const [passwordConfirmation, setPasswordConfirmation] = useState("");
  const [error, setError] = useState("");
  const [submitting, setSubmitting] = useState(false);

  async function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError("");
    const policyError = passwordPolicyError(password);
    if (policyError) {
      setError(policyError);
      return;
    }
    if (password !== passwordConfirmation) {
      setError("As senhas não coincidem.");
      return;
    }

    setSubmitting(true);
    try {
      const response = await fetch("/api/auth/register/complete", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token, name, password }),
      });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error ?? "Não foi possível criar sua conta.");
      router.replace("/feed");
      router.refresh();
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
        <h1 className="font-heading text-2xl font-extrabold">Finalize sua conta</h1>
        <p className="mt-2 text-sm text-muted-foreground">Escolha como você aparecerá nas tribos e crie uma senha segura.</p>
        {!token ? (
          <p role="alert" className="mt-6 rounded-xl border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive">
            O link está incompleto. Solicite um novo link de cadastro.
          </p>
        ) : (
          <form onSubmit={handleSubmit} className="mt-6 space-y-4">
            <div className="space-y-1.5">
              <Label htmlFor="name">Nome</Label>
              <Input id="name" value={name} onChange={(event) => setName(event.target.value)} minLength={2} maxLength={80} autoComplete="name" required />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="password">Senha</Label>
              <PasswordInput id="password" value={password} onChange={(event) => setPassword(event.target.value)} minLength={PASSWORD_MIN_LENGTH} maxLength={PASSWORD_MAX_LENGTH} autoComplete="new-password" required />
              <p className="text-xs text-muted-foreground">{PASSWORD_HINT}</p>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="password-confirmation">Confirme sua senha</Label>
              <PasswordInput id="password-confirmation" value={passwordConfirmation} onChange={(event) => setPasswordConfirmation(event.target.value)} minLength={PASSWORD_MIN_LENGTH} maxLength={PASSWORD_MAX_LENGTH} autoComplete="new-password" required />
            </div>
            {error && <p role="alert" className="rounded-xl border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive">{error}</p>}
            <Button type="submit" disabled={submitting} className="h-11 w-full rounded-xl font-semibold">
              {submitting && <LoaderCircle className="size-4 animate-spin" />}
              {submitting ? "Criando conta..." : "Criar conta e entrar"}
            </Button>
          </form>
        )}
      </section>
    </main>
  );
}
