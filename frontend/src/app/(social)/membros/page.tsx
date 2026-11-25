"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { ArrowLeft, Crown, LoaderCircle, MapPin, Search, Users } from "lucide-react";
import { UserAvatar } from "@/components/social/user-avatar";
import { apiRequest, type Tribe } from "@/lib/social-types";

type Member = {
  id: string;
  name: string;
  aboutMe: string;
  city: string;
  interests: string[];
  joinedAt: string;
  isModerator: boolean;
  avatarUrl: string | null;
};

export default function MembersPage() {
  const [tribes, setTribes] = useState<Tribe[]>([]);
  const [tribeId, setTribeId] = useState("");
  const [members, setMembers] = useState<Member[]>([]);
  const [query, setQuery] = useState("");
  const [cityFilter, setCityFilter] = useState("all");
  const [interestFilter, setInterestFilter] = useState("all");
  const [loadingTribes, setLoadingTribes] = useState(true);
  const [loadingMembers, setLoadingMembers] = useState(true);
  const [error, setError] = useState("");

  useEffect(() => {
    let active = true;
    apiRequest<{ tribes: Tribe[] }>("/api/tribes?mine=true")
      .then(({ tribes: result }) => { if (active) { setTribes(result); setTribeId(result[0]?.id ?? ""); } })
      .catch((err) => { if (active) setError(err instanceof Error ? err.message : "Não foi possível carregar suas tribos."); })
      .finally(() => { if (active) setLoadingTribes(false); });
    return () => { active = false; };
  }, []);

  useEffect(() => {
    if (!tribeId) return;
    let active = true;
    apiRequest<{ members: Member[] }>(`/api/tribes/${tribeId}/members`)
      .then(({ members: result }) => { if (active) setMembers(result); })
      .catch((err) => { if (active) setError(err instanceof Error ? err.message : "Não foi possível carregar os membros."); })
      .finally(() => { if (active) setLoadingMembers(false); });
    return () => { active = false; };
  }, [tribeId]);

  const cities = useMemo(() => [...new Set(members.map((member) => member.city).filter(Boolean))].sort((a, b) => a.localeCompare(b, "pt-BR")), [members]);
  const interests = useMemo(() => [...new Set(members.flatMap((member) => member.interests ?? []))].sort((a, b) => a.localeCompare(b, "pt-BR")), [members]);
  const filtered = useMemo(() => members.filter((member) => {
    const normalizedQuery = query.toLocaleLowerCase("pt-BR");
    const matchesQuery = !normalizedQuery ||
      member.name.toLocaleLowerCase("pt-BR").includes(normalizedQuery) ||
      member.city.toLocaleLowerCase("pt-BR").includes(normalizedQuery) ||
      member.interests.some((interest) => interest.toLocaleLowerCase("pt-BR").includes(normalizedQuery));
    const matchesCity = cityFilter === "all" || member.city === cityFilter;
    const matchesInterest = interestFilter === "all" || member.interests.includes(interestFilter);
    return matchesQuery && matchesCity && matchesInterest;
  }), [members, query, cityFilter, interestFilter]);

  return (
    <main className="mx-auto max-w-3xl space-y-6">
      <Link href="/tribos" className="inline-flex min-h-10 items-center gap-2 rounded-xl px-3 text-sm font-semibold text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
        <ArrowLeft className="size-4" />
        Voltar às tribos
      </Link>
      <section>
        <p className="text-xs font-bold uppercase tracking-[0.18em] text-primary">Comunidade</p>
        <h1 className="mt-2 font-heading text-3xl font-extrabold">Membros das tribos</h1>
        <p className="mt-1 text-sm text-muted-foreground">Conheça as pessoas que fazem parte das suas comunidades.</p>
      </section>
      {loadingTribes ? <div className="flex justify-center py-12"><LoaderCircle className="size-6 animate-spin text-primary" /></div> : tribes.length ? (
        <>
          <select aria-label="Selecionar tribo" value={tribeId} onChange={(event) => { setTribeId(event.target.value); setCityFilter("all"); setInterestFilter("all"); setMembers([]); setLoadingMembers(true); }} className="h-11 w-full rounded-xl border border-input bg-background px-3 text-sm">
            {tribes.map((tribe) => <option key={tribe.id} value={tribe.id}>{tribe.name}</option>)}
          </select>
          <div className="relative">
            <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
            <input aria-label="Pesquisar membros" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Pesquisar por nome ou cidade..." className="h-11 w-full rounded-xl border border-input bg-background pl-10 pr-3 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring" />
          </div>
          <div className="grid gap-3 sm:grid-cols-2">
            <label className="space-y-1.5 text-xs font-semibold text-muted-foreground">
              Cidade
              <select value={cityFilter} onChange={(event) => setCityFilter(event.target.value)} className="h-11 w-full rounded-xl border border-input bg-background px-3 text-sm font-normal text-foreground">
                <option value="all">Todas as cidades</option>
                {cities.map((city) => <option key={city} value={city}>{city}</option>)}
              </select>
            </label>
            <label className="space-y-1.5 text-xs font-semibold text-muted-foreground">
              Interesse
              <select value={interestFilter} onChange={(event) => setInterestFilter(event.target.value)} className="h-11 w-full rounded-xl border border-input bg-background px-3 text-sm font-normal text-foreground">
                <option value="all">Todos os interesses</option>
                {interests.map((interest) => <option key={interest} value={interest}>{interest}</option>)}
              </select>
            </label>
          </div>
          {error && <p role="alert" className="rounded-xl bg-destructive/10 p-3 text-sm text-destructive">{error}</p>}
          {loadingMembers ? <div className="flex justify-center py-8"><LoaderCircle className="size-6 animate-spin text-primary" /></div> : (
            <div className="divide-y divide-border overflow-hidden rounded-2xl border border-border bg-card">
              {filtered.map((member) => (
                <Link key={member.id} href={`/usuarios/${member.id}`} className="flex items-center gap-3 p-4 transition-colors hover:bg-muted/50">
                  <UserAvatar name={member.name} avatarUrl={member.avatarUrl} />
                  <span className="min-w-0 flex-1">
                    <span className="flex items-center gap-2 text-sm font-semibold">{member.name}{member.isModerator && <span className="inline-flex items-center gap-1 rounded-full bg-primary/10 px-2 py-0.5 text-[10px] text-primary"><Crown className="size-3" />Moderador</span>}</span>
                    <span className="mt-1 block truncate text-xs text-muted-foreground">{member.aboutMe || (member.city ? <><MapPin className="mr-1 inline size-3" />{member.city}</> : "Ver perfil")}</span>
                    {member.interests.length > 0 && <span className="mt-2 flex flex-wrap gap-1.5">{member.interests.slice(0, 3).map((interest) => <span key={interest} className="rounded-full bg-primary/8 px-2 py-0.5 text-[10px] font-medium text-primary">{interest}</span>)}</span>}
                  </span>
                </Link>
              ))}
              {!filtered.length && <p className="p-8 text-center text-sm text-muted-foreground">Nenhum membro encontrado.</p>}
            </div>
          )}
        </>
      ) : (
        <section className="rounded-3xl border border-dashed border-border bg-card px-5 py-12 text-center">
          <Users className="mx-auto size-8 text-primary" />
          <h2 className="mt-3 font-heading text-xl font-bold">Entre em uma tribo</h2>
          <p className="mt-2 text-sm text-muted-foreground">O diretório mostra os membros das comunidades das quais você participa.</p>
        </section>
      )}
    </main>
  );
}
