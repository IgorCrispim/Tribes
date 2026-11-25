"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { ArrowLeft, LoaderCircle, MapPin, Users } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { PasswordInput } from "@/components/ui/password-input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { INTEREST_CATEGORIES } from "@/lib/tribes-data";
import { apiRequest } from "@/lib/social-types";

type Municipality = { nome: string; microrregiao?: { mesorregiao?: { UF?: { sigla?: string } } } };

export default function NewTribePage() {
  const router = useRouter();
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [category, setCategory] = useState(INTEREST_CATEGORIES[0].label);
  const [format, setFormat] = useState<"Presencial" | "Híbrido" | "Online">("Presencial");
  const [city, setCity] = useState("");
  const [citySelected, setCitySelected] = useState(false);
  const [municipalities, setMunicipalities] = useState<Municipality[]>([]);
  useEffect(() => { let active=true; fetch("https://servicodados.ibge.gov.br/api/v1/localidades/municipios?orderBy=nome").then(r=>r.json()).then(data=>{if(active)setMunicipalities(data)}).catch(()=>undefined); return ()=>{active=false}; }, []);
  const citySuggestions = useMemo(() => { const query = city.trim().toLocaleLowerCase("pt-BR"); if (query.length < 2 || citySelected) return []; return municipalities.filter(item => item.nome.toLocaleLowerCase("pt-BR").includes(query)).slice(0,8); }, [city,citySelected,municipalities]);
  const [neighborhood, setNeighborhood] = useState("");
  const [isPrivate, setIsPrivate] = useState(false);
  const [password, setPassword] = useState("");
  const [passwordConfirmation, setPasswordConfirmation] = useState("");
  const [error, setError] = useState("");
  const [submitting, setSubmitting] = useState(false);

  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (submitting) return;
    if (!citySelected) { setError("Escolha uma cidade na lista de sugestões."); return; }
    if (isPrivate && (!password.trim() || !passwordConfirmation.trim())) { setError("Informe a senha da tribo e sua confirmação."); return; }
    if (isPrivate && password !== passwordConfirmation) { setError("As senhas da tribo não coincidem."); return; }
    setSubmitting(true);
    setError("");
    try {
      await apiRequest("/api/tribes", {
        method: "POST",
        body: JSON.stringify({ name, description, category, format, city, neighborhood, isPrivate, ...(isPrivate ? { password, passwordConfirmation } : {}) }),
      });
      setName("");
      setDescription("");
      setCategory(INTEREST_CATEGORIES[0].label);
      setFormat("Presencial");
      setCity("");
      setCitySelected(false);
      setNeighborhood("");
      router.replace("/minhas-tribos");
    } catch (submitError) {
      setError(submitError instanceof Error ? submitError.message : "Não foi possível criar a tribo.");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <main className="mx-auto max-w-2xl">
      <Link href="/tribos" className="inline-flex items-center gap-2 text-sm font-semibold text-muted-foreground hover:text-foreground"><ArrowLeft className="size-4" />Voltar para tribos</Link>
      <section className="mt-5 rounded-3xl border border-border bg-card p-5 shadow-xs sm:p-8">
        <div className="flex size-11 items-center justify-center rounded-2xl bg-primary/10 text-primary"><Users className="size-5" /></div>
        <h1 className="mt-4 font-heading text-2xl font-extrabold">Crie uma nova tribo</h1>
        <p className="mt-2 text-sm text-muted-foreground">Você será o primeiro membro e poderá começar a publicar assim que criar a comunidade.</p>
        <form onSubmit={(event) => void submit(event)} className="mt-6 space-y-4">
          <div className="space-y-1.5"><Label htmlFor="tribe-name">Nome da tribo</Label><Input id="tribe-name" value={name} onChange={(event) => setName(event.target.value)} minLength={2} maxLength={80} placeholder="Ex.: Clube de corrida da Pampulha" required /></div>
          <div className="space-y-1.5"><Label htmlFor="tribe-description">Descrição</Label><Textarea id="tribe-description" value={description} onChange={(event) => setDescription(event.target.value)} minLength={2} maxLength={1000} placeholder="Conte o que une as pessoas desta tribo..." required /></div>
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-1.5"><Label htmlFor="tribe-category">Interesse</Label><select id="tribe-category" value={category} onChange={(event) => setCategory(event.target.value)} className="h-10 w-full rounded-xl border border-input bg-background px-3 text-sm">{INTEREST_CATEGORIES.map((interest) => <option key={interest.id} value={interest.label}>{interest.label}</option>)}</select></div>
            <div className="space-y-1.5"><Label htmlFor="tribe-format">Formato</Label><select id="tribe-format" value={format} onChange={(event) => setFormat(event.target.value as typeof format)} className="h-10 w-full rounded-xl border border-input bg-background px-3 text-sm"><option>Presencial</option><option>Híbrido</option><option>Online</option></select></div>
            <div className="space-y-1.5"><Label htmlFor="tribe-city" className="flex items-center gap-2"><MapPin className="size-4 text-primary" />Cidade</Label><div className="relative"><Input id="tribe-city" value={city} onChange={(event) => { setCity(event.target.value); setCitySelected(false); }} autoComplete="off" placeholder="Digite sua cidade..." role="combobox" aria-autocomplete="list" aria-expanded={citySuggestions.length > 0} required />{citySuggestions.length > 0 && <ul role="listbox" className="absolute z-20 mt-1 max-h-64 w-full overflow-auto rounded-xl border border-border bg-card p-1 shadow-lg">{citySuggestions.map(item => { const uf = item.microrregiao?.mesorregiao?.UF?.sigla ?? ""; const label = uf ? item.nome + " - " + uf : item.nome; return <li key={label} role="option" aria-selected={false}><button type="button" onClick={() => { setCity(label); setCitySelected(true); }} className="w-full rounded-lg px-3 py-2 text-left text-sm hover:bg-muted">{label}</button></li>; })}</ul>}</div></div>
            <div className="space-y-1.5"><Label htmlFor="tribe-neighborhood">Bairro (opcional)</Label><Input id="tribe-neighborhood" value={neighborhood} onChange={(event) => setNeighborhood(event.target.value)} maxLength={100} placeholder="Ex.: Pampulha" /></div>
          </div>
          <fieldset className="space-y-3">
            <legend className="mb-2 text-sm font-semibold">Privacidade da tribo</legend>
            <label className="flex cursor-pointer items-start gap-2 text-sm"><input type="radio" name="privacy" checked={!isPrivate} onChange={() => setIsPrivate(false)} className="mt-1" /><span><strong>Tribo pública</strong><br /><span className="text-muted-foreground">Qualquer usuário pode entrar sem senha.</span></span></label>
            <label className="flex cursor-pointer items-start gap-2 text-sm"><input type="radio" name="privacy" checked={isPrivate} onChange={() => setIsPrivate(true)} className="mt-1" /><span><strong>Tribo privada</strong><br /><span className="text-muted-foreground">É necessário informar a senha para entrar.</span></span></label>
          </fieldset>
          {isPrivate && <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-1.5"><Label htmlFor="tribe-password">Senha da tribo</Label><PasswordInput id="tribe-password" value={password} onChange={(event) => setPassword(event.target.value)} maxLength={128} autoComplete="new-password" required /></div>
            <div className="space-y-1.5"><Label htmlFor="tribe-password-confirmation">Confirmar senha</Label><PasswordInput id="tribe-password-confirmation" value={passwordConfirmation} onChange={(event) => setPasswordConfirmation(event.target.value)} maxLength={128} autoComplete="new-password" required /></div>
          </div>}
          {error && <p role="alert" className="rounded-xl border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive">{error}</p>}
          <Button type="submit" disabled={submitting} className="h-11 w-full rounded-xl font-semibold sm:w-auto">
            {submitting ? <LoaderCircle className="size-4 animate-spin" /> : <Users className="size-4" />}
            {submitting ? "Criando tribo..." : "Criar tribo e abrir meu feed"}
          </Button>
        </form>
      </section>
    </main>
  );
}
