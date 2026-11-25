"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { Compass, LoaderCircle, MapPin, Plus, Search, Users } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { apiRequest, type Tribe } from "@/lib/social-types";

export default function TribesPage() {
  const [query, setQuery] = useState("");
  const [cityFilter, setCityFilter] = useState("all");
  const [interestFilter, setInterestFilter] = useState("all");
  const [tribes, setTribes] = useState<Tribe[]>([]);
  const [loading, setLoading] = useState(true);
  const [workingTribe, setWorkingTribe] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const cities = useMemo(() => [...new Set(tribes.map((tribe) => tribe.city).filter(Boolean))].sort((a, b) => a.localeCompare(b, "pt-BR")), [tribes]);
  const interests = useMemo(() => [...new Set(tribes.map((tribe) => tribe.category).filter(Boolean))].sort((a, b) => a.localeCompare(b, "pt-BR")), [tribes]);
  const sortedTribes = useMemo(() => tribes
    .filter((tribe) => cityFilter === "all" || tribe.city === cityFilter)
    .filter((tribe) => interestFilter === "all" || tribe.category === interestFilter)
    .sort((a, b) => b.memberCount - a.memberCount), [tribes, cityFilter, interestFilter]);

  useEffect(() => {
    let active = true;
    const timeout = window.setTimeout(() => {
      setLoading(true);
      const params = new URLSearchParams();
      if (query.trim()) params.set("q", query.trim());
      apiRequest<{ tribes: Tribe[] }>(`/api/tribes?${params}`)
        .then(({ tribes: data }) => { if (active) { setTribes(data); setError(""); } })
        .catch((requestError) => { if (active) setError(requestError instanceof Error ? requestError.message : "Não foi possível buscar tribos."); })
        .finally(() => { if (active) setLoading(false); });
    }, 250);
    return () => { active = false; window.clearTimeout(timeout); };
  }, [query]);

  async function toggleMembership(tribe: Tribe) {
    setWorkingTribe(tribe.id);
    setError("");
    setMessage("");
    try {
      const joined = !tribe.isMember;
      const result = await apiRequest<{ isMember: boolean; tribeDeleted?: boolean }>(`/api/tribes/${tribe.id}/${joined ? "join" : "membership"}`, { method: joined ? "POST" : "DELETE" });
      if (result.tribeDeleted) {
        setTribes((current) => current.filter((entry) => entry.id !== tribe.id));
        setMessage("Você era o único membro. A tribo foi excluída automaticamente.");
        return;
      }
      setTribes((current) => current.map((entry) => entry.id === tribe.id ? {
        ...entry,
        isMember: joined,
        memberCount: Math.max(0, entry.memberCount + (joined ? 1 : -1)),
      } : entry));
    } catch (membershipError) {
      setError(membershipError instanceof Error ? membershipError.message : "Não foi possível atualizar sua participação.");
    } finally {
      setWorkingTribe(null);
    }
  }

  return (
    <main className="space-y-7">
      <section className="flex flex-col justify-between gap-4 sm:flex-row sm:items-end">
        <div>
          <Badge className="bg-primary/10 text-primary"><Compass className="size-3" />Descubra comunidades</Badge>
          <h1 className="mt-2 font-heading text-3xl font-extrabold">Encontre sua próxima tribo</h1>
          <p className="mt-1 text-sm text-muted-foreground">Busque por interesse, comunidade ou cidade e participe.</p>
        </div>
        <Button render={<Link href="/tribos/nova" />} className="rounded-xl"><Plus className="size-4" />Criar tribo</Button>
      </section>

      <section className="space-y-3 rounded-2xl border border-border bg-card p-4 sm:p-5">
        <div className="relative">
          <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Buscar por nome, interesse ou cidade..." aria-label="Buscar tribos" className="h-12 rounded-xl pl-10" />
        </div>
        <div className="grid gap-3 sm:grid-cols-2">
          <label className="space-y-1.5 text-xs font-semibold text-muted-foreground">Cidade
            <select value={cityFilter} onChange={(event) => setCityFilter(event.target.value)} className="h-11 w-full rounded-xl border border-input bg-background px-3 text-sm font-normal text-foreground">
              <option value="all">Todas as cidades</option>
              {cities.map((city) => <option key={city} value={city}>{city}</option>)}
            </select>
          </label>
          <label className="space-y-1.5 text-xs font-semibold text-muted-foreground">Interesse
            <select value={interestFilter} onChange={(event) => setInterestFilter(event.target.value)} className="h-11 w-full rounded-xl border border-input bg-background px-3 text-sm font-normal text-foreground">
              <option value="all">Todos os interesses</option>
              {interests.map((interest) => <option key={interest} value={interest}>{interest}</option>)}
            </select>
          </label>
        </div>
      </section>
      {error && <p role="alert" className="rounded-xl border border-destructive/30 bg-destructive/10 px-4 py-3 text-sm text-destructive">{error}</p>}
      {message && <p role="status" className="rounded-xl border border-primary/30 bg-primary/10 px-4 py-3 text-sm text-primary">{message}</p>}
      {loading ? <div className="flex justify-center py-14"><LoaderCircle className="size-6 animate-spin text-primary" /></div> : sortedTribes.length ? (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {sortedTribes.map((tribe) => <article key={tribe.id} className="flex flex-col rounded-3xl border border-border bg-card p-5 shadow-xs">
            <div className="flex items-start justify-between gap-2"><Badge variant="secondary">{tribe.category}</Badge><Badge variant="outline">{tribe.format}</Badge></div>
            <h2 className="mt-4 font-heading text-lg font-bold">{tribe.name}</h2>
            <p className="mt-2 line-clamp-3 flex-1 whitespace-pre-wrap text-sm leading-relaxed text-muted-foreground">{tribe.description}</p>
            <div className="mt-4 flex flex-wrap gap-x-4 gap-y-2 text-xs text-muted-foreground">
              <span className="inline-flex items-center gap-1"><MapPin className="size-3.5 text-primary" />{[tribe.neighborhood, tribe.city].filter(Boolean).join(" · ")}</span>
              <span className="inline-flex items-center gap-1"><Users className="size-3.5 text-primary" />{tribe.memberCount} {tribe.memberCount === 1 ? "membro" : "membros"}</span>
            </div>
            <Button type="button" variant={tribe.isMember ? "outline" : "default"} disabled={workingTribe === tribe.id} onClick={() => void toggleMembership(tribe)} className="mt-5 w-full rounded-xl">
              {workingTribe === tribe.id && <LoaderCircle className="size-4 animate-spin" />}
              {tribe.isMember ? "Sair da tribo" : "Participar da tribo"}
            </Button>
          </article>)}
        </div>
      ) : <div className="rounded-3xl border border-dashed border-border bg-card px-5 py-12 text-center">
        <h2 className="font-heading text-lg font-bold">Nenhuma tribo encontrada</h2>
        <p className="mt-2 text-sm text-muted-foreground">Crie a comunidade que está procurando e convide outras pessoas.</p>
        <Button render={<Link href="/tribos/nova" />} className="mt-4 rounded-xl"><Plus className="size-4" />Criar uma tribo</Button>
      </div>}
    </main>
  );
}
