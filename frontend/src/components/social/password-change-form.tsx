"use client";

import { useState } from "react";
import { Check, KeyRound, LoaderCircle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { PASSWORD_HINT, PASSWORD_MAX_LENGTH, PASSWORD_MIN_LENGTH, passwordPolicyError } from "@/lib/password-policy";
import { apiRequest } from "@/lib/social-types";

export function PasswordChangeForm() {
  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [passwordConfirmation, setPasswordConfirmation] = useState("");
  const [error, setError] = useState("");
  const [success, setSuccess] = useState(false);
  const [submitting, setSubmitting] = useState(false);

  async function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError("");
    setSuccess(false);
    const policyError = passwordPolicyError(newPassword);
    if (policyError) {
      setError(policyError);
      return;
    }
    if (newPassword !== passwordConfirmation) {
      setError("A confirmação não corresponde à nova senha.");
      return;
    }

    setSubmitting(true);
    try {
      await apiRequest<{ ok: boolean }>("/api/auth/password-change", {
        method: "POST",
        body: JSON.stringify({ currentPassword, newPassword, confirmPassword: passwordConfirmation }),
      });
      setCurrentPassword("");
      setNewPassword("");
      setPasswordConfirmation("");
      setSuccess(true);
    } catch (submitError) {
      setError(submitError instanceof Error ? submitError.message : "Não foi possível alterar sua senha.");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <section className="mt-6 space-y-4 rounded-3xl border border-border bg-card p-5 shadow-xs sm:p-8">
      <header>
        <p className="flex items-center gap-2 text-sm font-semibold text-primary"><KeyRound className="size-4" />Segurança da conta</p>
        <h2 className="mt-2 font-heading text-xl font-extrabold">Alterar senha</h2>
        <p className="mt-1 text-sm text-muted-foreground">Confirme sua senha atual e escolha uma nova. A alteração encerra as outras sessões da sua conta.</p>
      </header>

      <form onSubmit={(event) => void handleSubmit(event)} className="max-w-xl space-y-4">
        <div className="space-y-1.5">
          <Label htmlFor="current-password">Senha atual</Label>
          <Input id="current-password" type="password" value={currentPassword} onChange={(event) => setCurrentPassword(event.target.value)} maxLength={128} autoComplete="current-password" required />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="new-password">Nova senha</Label>
          <Input id="new-password" type="password" value={newPassword} onChange={(event) => setNewPassword(event.target.value)} minLength={PASSWORD_MIN_LENGTH} maxLength={PASSWORD_MAX_LENGTH} autoComplete="new-password" required />
          <p className="text-xs text-muted-foreground">{PASSWORD_HINT}</p>
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="password-confirmation">Confirme sua nova senha</Label>
          <Input id="password-confirmation" type="password" value={passwordConfirmation} onChange={(event) => setPasswordConfirmation(event.target.value)} minLength={PASSWORD_MIN_LENGTH} maxLength={PASSWORD_MAX_LENGTH} autoComplete="new-password" required />
        </div>
        {error && <p role="alert" className="rounded-xl border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive">{error}</p>}
        {success && <p role="status" className="flex items-center gap-2 text-sm font-medium text-primary"><Check className="size-4" />Senha alterada. As outras sessões foram encerradas.</p>}
        <Button type="submit" disabled={submitting || !currentPassword || !newPassword || !passwordConfirmation} className="rounded-xl">
          {submitting ? <LoaderCircle className="size-4 animate-spin" /> : <KeyRound className="size-4" />}
          {submitting ? "Alterando..." : "Alterar senha"}
        </Button>
      </form>
    </section>
  );
}
