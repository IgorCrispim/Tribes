"use client";

import { useEffect, useMemo, useState } from "react";
import Image from "next/image";
import { useRouter } from "next/navigation";
import { Camera, Check, LoaderCircle, LogOut, MapPin, Plus, Save, Trash2, UserRound, X } from "lucide-react";
import { useCurrentUser, type CurrentUser } from "@/components/social/auth-guard";
import { UserAvatar } from "@/components/social/user-avatar";
import { PasswordChangeForm } from "@/components/social/password-change-form";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { ImageFileError, readImageAsDataUrl } from "@/lib/image-file";
import { apiRequest } from "@/lib/social-types";

type Municipality = { nome: string; microrregiao?: { mesorregiao?: { UF?: { sigla?: string } } } };
const INTEREST_SUGGESTIONS = ["Música", "Cinema", "Leitura", "Tecnologia", "Games", "Esportes", "Corrida", "Culinária", "Viagens", "Fotografia", "Arte", "Natureza", "Trilhas", "Empreendedorismo", "Pets", "Moda"];

export default function ProfileSettingsPage() {
  const { user, setUser } = useCurrentUser();
  const router = useRouter();
  const [name, setName] = useState(user.name);
  const [aboutMe, setAboutMe] = useState(user.aboutMe);
  const [city, setCity] = useState(user.city ?? "");
  const [citySelected, setCitySelected] = useState(Boolean(user.city));
  const [municipalities, setMunicipalities] = useState<Municipality[]>([]);
  const [cityError, setCityError] = useState("");
  const [interests, setInterests] = useState<string[]>(user.interests ?? []);
  const [profileVisibility, setProfileVisibility] = useState(user.profileVisibility ?? { aboutMe: "public", city: "public", interests: "public" });
  const [interestInput, setInterestInput] = useState("");
  const [avatar, setAvatar] = useState<string | null | undefined>(undefined);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState("");

  const previewUrl = avatar === undefined ? user.avatarUrl : avatar;
  const citySuggestions = useMemo(() => {
    const query = city.trim().toLocaleLowerCase("pt-BR");
    if (query.length < 2 || citySelected) return [];
    return municipalities
      .filter((item) => {
        const uf = item.microrregiao?.mesorregiao?.UF?.sigla ?? "";
        return item.nome.toLocaleLowerCase("pt-BR").includes(query) ||
          `${item.nome} - ${uf}`.toLocaleLowerCase("pt-BR").includes(query);
      })
      .slice(0, 8);
  }, [city, citySelected, municipalities]);

  useEffect(() => {
    let active = true;
    fetch("https://servicodados.ibge.gov.br/api/v1/localidades/municipios?orderBy=nome")
      .then((response) => {
        if (!response.ok) throw new Error("Não foi possível consultar o IBGE.");
        return response.json() as Promise<Municipality[]>;
      })
      .then((data) => { if (active) setMunicipalities(data); })
      .catch(() => { if (active) setCityError("Não foi possível carregar as cidades. Confira sua conexão e tente novamente."); })
      ;
    return () => { active = false; };
  }, []);

  async function selectAvatar(event: React.ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    setError("");
    setSaved(false);
    if (!file) return;
    try {
      setAvatar(await readImageAsDataUrl(file));
    } catch (imageError) {
      setError(imageError instanceof ImageFileError && imageError.code === "unsupported-type"
        ? "Escolha uma imagem JPEG, PNG ou WebP."
        : imageError instanceof ImageFileError && imageError.code === "too-large"
          ? "A foto deve ter no máximo 5 MB."
          : "Não foi possível ler essa imagem.");
      event.target.value = "";
    }
  }

  function addInterest(value = interestInput) {
    const normalized = value.trim().replace(/\s+/g, " ").slice(0, 30);
    if (!normalized || interests.some((item) => item.toLocaleLowerCase("pt-BR") === normalized.toLocaleLowerCase("pt-BR")) || interests.length >= 20) return;
    setInterests((current) => [...current, normalized]);
    setInterestInput("");
    setSaved(false);
  }

  async function saveProfile(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (city.trim() && !citySelected) {
      setError("Escolha uma cidade na lista de sugestões do IBGE.");
      return;
    }
    setSaving(true);
    setError("");
    setSaved(false);
    try {
      const payload = { name, aboutMe, city, interests, profileVisibility, ...(avatar !== undefined ? { avatar } : {}) };
      const result = await apiRequest<{ user: CurrentUser }>("/api/profile", {
        method: "PATCH",
        body: JSON.stringify(payload),
      });
      setUser(result.user);
      setName(result.user.name);
      setAboutMe(result.user.aboutMe);
      setCity(result.user.city);
      setCitySelected(Boolean(result.user.city));
      setInterests(result.user.interests);
      setProfileVisibility(result.user.profileVisibility);
      setAvatar(undefined);
      setSaved(true);
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : "Não foi possível salvar seu perfil.");
    } finally {
      setSaving(false);
    }
  }

  async function logout() {
    await fetch("/api/auth/logout", { method: "POST" });
    router.replace("/");
  }

  return (
    <main className="mx-auto max-w-3xl space-y-6">
      <header className="flex items-start justify-between gap-3">
        <div>
          <p className="flex items-center gap-2 text-sm font-semibold text-primary"><UserRound className="size-4" />Sua conta</p>
          <h1 className="mt-2 font-heading text-3xl font-extrabold">Editar perfil</h1>
          <p className="mt-1 text-sm text-muted-foreground">Personalize seu espaço e mostre à comunidade o que você curte.</p>
        </div>
        <Button type="button" variant="ghost" aria-label="Sair da conta" onClick={() => void logout()} className="shrink-0 text-muted-foreground hover:text-destructive">
          <LogOut className="size-4" />Sair<span className="hidden sm:inline"> da conta</span>
        </Button>
      </header>

      <form onSubmit={(event) => void saveProfile(event)} className="space-y-7 rounded-3xl border border-border bg-card p-5 shadow-xs sm:p-8">
        <section className="flex flex-col items-start gap-4 sm:flex-row sm:items-center">
          <div className="relative">
            {previewUrl ? (
              <div className="relative size-28 overflow-hidden rounded-full border-4 border-background bg-muted shadow-sm">
                <Image src={previewUrl} alt={`Prévia da foto de ${name}`} fill unoptimized sizes="112px" className="object-cover" />
              </div>
            ) : <UserAvatar name={name} avatarUrl={null} className="size-28 text-3xl" />}
          </div>
          <div className="space-y-2">
            <h2 className="font-heading text-lg font-bold">Foto de perfil</h2>
            <p className="text-sm text-muted-foreground">JPEG, PNG ou WebP · até 5 MB</p>
            <div className="flex flex-wrap gap-2">
              <label htmlFor="profile-avatar" className="inline-flex h-9 cursor-pointer items-center gap-2 rounded-lg border border-border bg-background px-3 text-sm font-medium transition-colors hover:bg-muted">
                <Camera className="size-4" />Escolher foto
              </label>
              <Input id="profile-avatar" type="file" accept="image/jpeg,image/png,image/webp" onChange={selectAvatar} className="sr-only" aria-label="Escolher foto de perfil" />
              {previewUrl && <Button type="button" variant="ghost" size="sm" onClick={() => { setAvatar(null); setSaved(false); }}><Trash2 className="size-4" />Remover</Button>}
            </div>
          </div>
        </section>

        <div className="grid gap-5 sm:grid-cols-2">
          <div className="space-y-2">
            <label htmlFor="profile-name" className="flex h-5 items-center text-sm font-semibold leading-5">Nome</label>
            <Input id="profile-name" value={name} onChange={(event) => { setName(event.target.value); setSaved(false); }} minLength={2} maxLength={80} required autoComplete="name" />
          </div>
          <div className="space-y-2">
            <label htmlFor="profile-city" className="flex h-5 items-center gap-2 text-sm font-semibold leading-5"><MapPin className="size-4 shrink-0 text-primary" />Cidade</label>
            <div className="relative">
              <Input id="profile-city" value={city} onChange={(event) => { setCity(event.target.value); setCitySelected(false); setSaved(false); }} autoComplete="off" placeholder="Digite sua cidade..." role="combobox" aria-autocomplete="list" aria-expanded={citySuggestions.length > 0} />
              {citySuggestions.length > 0 && (
                <ul role="listbox" className="absolute z-20 mt-1 max-h-64 w-full overflow-auto rounded-xl border border-border bg-card p-1 shadow-lg">
                  {citySuggestions.map((item) => {
                    const uf = item.microrregiao?.mesorregiao?.UF?.sigla ?? "";
                    const label = uf ? `${item.nome} - ${uf}` : item.nome;
                    return <li key={label} role="option" aria-selected={false}>
                      <button type="button" onClick={() => { setCity(label); setCitySelected(true); setSaved(false); }} className="w-full rounded-lg px-3 py-2 text-left text-sm hover:bg-muted">{label}</button>
                    </li>;
                  })}
                </ul>
              )}
            </div>

            {cityError && <p role="status" className="text-xs text-destructive">{cityError}</p>}
          </div>
        </div>

        <div className="space-y-2">
          <label htmlFor="profile-about" className="text-sm font-semibold">Sobre mim</label>
          <Textarea id="profile-about" value={aboutMe} onChange={(event) => { setAboutMe(event.target.value); setSaved(false); }} maxLength={500} rows={4} placeholder="Conte um pouco sobre você..." />
          <p className="text-right text-xs text-muted-foreground">{aboutMe.length}/500</p>
        </div>

        <section className="space-y-3">
          <div>
            <h2 className="font-heading text-lg font-bold">Meus interesses</h2>
            <p className="mt-1 text-sm text-muted-foreground">Adicione assuntos e atividades que você gosta para aproximar pessoas com interesses em comum.</p>
          </div>
          <div className="flex flex-wrap gap-2">
            {interests.map((interest) => (
              <span key={interest} className="inline-flex items-center gap-1.5 rounded-full border border-primary/20 bg-primary/8 px-3 py-1.5 text-sm font-medium text-primary">
                {interest}
                <button type="button" aria-label={`Remover ${interest}`} onClick={() => { setInterests((current) => current.filter((item) => item !== interest)); setSaved(false); }} className="rounded-full hover:bg-primary/10"><X className="size-3.5" /></button>
              </span>
            ))}
            {interests.length === 0 && <p className="text-sm text-muted-foreground">Você ainda não adicionou interesses.</p>}
          </div>
          <div className="flex gap-2">
            <Input value={interestInput} onChange={(event) => setInterestInput(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter") { event.preventDefault(); addInterest(); } }} maxLength={30} placeholder="Adicionar um interesse..." aria-label="Novo interesse" />
            <Button type="button" variant="outline" onClick={() => addInterest()} disabled={!interestInput.trim() || interests.length >= 20}><Plus className="size-4" />Adicionar</Button>
          </div>
          <div className="flex flex-wrap gap-2">
            {INTEREST_SUGGESTIONS.filter((item) => !interests.includes(item)).slice(0, 10).map((item) => (
              <button key={item} type="button" onClick={() => addInterest(item)} disabled={interests.length >= 20} className="rounded-full border border-border px-3 py-1 text-xs text-muted-foreground transition-colors hover:border-primary/40 hover:text-primary disabled:opacity-40">+ {item}</button>
            ))}
          </div>
          <p className="text-xs text-muted-foreground">{interests.length}/20 interesses</p>
        </section>


        <section className="space-y-4 border-t border-border pt-6">
          <div>
            <h2 className="font-heading text-lg font-bold">Privacidade</h2>
            <p className="mt-1 text-sm text-muted-foreground">Escolha quem pode ver cada informação.</p>
          </div>
          {([
            ["aboutMe", "Sobre mim"],
            ["city", "Cidade"],
            ["interests", "Interesses"],
          ] as const).map(([field, label]) => (
            <div key={field} className="flex flex-col gap-2 rounded-xl border border-border p-3 sm:flex-row sm:items-center sm:justify-between">
              <span className="text-sm font-medium">{label}</span>
              <select
                aria-label={"Quem pode ver " + label.toLocaleLowerCase("pt-BR")}
                value={profileVisibility[field]}
                onChange={(event) => {
                  setProfileVisibility((current) => ({ ...current, [field]: event.target.value as "public" | "private" }));
                  setSaved(false);
                }}
                className="h-10 w-full rounded-lg border border-input bg-background px-3 text-sm sm:w-48"
              >
                <option value="public">Todos</option>
                <option value="private">Somente eu</option>
              </select>
            </div>
          ))}
        </section>

        {error && <p role="alert" className="rounded-xl bg-destructive/10 px-3 py-2 text-sm text-destructive">{error}</p>}
        {saved && <p role="status" className="flex items-center gap-2 text-sm font-medium text-primary"><Check className="size-4" />Perfil atualizado.</p>}
        <div className="flex flex-wrap items-center justify-between gap-3 border-t border-border pt-4">
          <Button type="submit" disabled={saving || name.trim().length < 2} className="rounded-xl">
            {saving ? <LoaderCircle className="size-4 animate-spin" /> : <Save className="size-4" />}
            {saving ? "Salvando..." : "Salvar alterações"}
          </Button>
        </div>
      </form>
      <PasswordChangeForm />
    </main>
  );
}
