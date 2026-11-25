"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { ArrowRight, LoaderCircle, MapPin, Plus, Users } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { apiRequest, type Tribe } from "@/lib/social-types";

type MyTribe = Tribe;

export default function MyTribesPage() {
  const [tribes, setTribes] = useState<MyTribe[]>([]);
  const [filter, setFilter] = useState<"all" | "moderator" | "participant">("all");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  useEffect(() => {
    let active = true;
    apiRequest<{ tribes: MyTribe[] }>("/api/tribes?mine=true")
      .then(({ tribes: data }) => {
        if (active) {
          setTribes(data);
          setError("");
        }
      })
      .catch((requestError) => {
        if (active) setError(requestError instanceof Error ? requestError.message : "Não foi possível carregar suas tribos.");
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => { active = false; };
  }, []);

  const filteredTribes = tribes.filter((tribe) => {
    if (filter === "moderator") return tribe.isModerator === true;
    if (filter === "participant") return tribe.isModerator !== true;
    return true;
  });

  return (
    <main className="space-y-7">
      <section className="flex flex-col justify-between gap-4 sm:flex-row sm:items-end">
        <div>
          <Badge className="bg-primary/10 text-primary"><Users className="size-3" />Sua área de gestão</Badge>
          <h1 className="mt-2 font-heading text-3xl font-extrabold">Minhas tribos</h1>
          <p className="mt-1 text-sm text-muted-foreground">Acompanhe as comunidades que você administra ou participa.</p>
        </div>
        <Button nativeButton={false} render={<Link href="/tribos/nova" />} className="w-full rounded-xl sm:w-auto">
          <Plus className="size-4" />Criar tribo
        </Button>
      </section>

      {!loading && (
        <div className="flex flex-wrap items-center gap-2 border-b border-border pb-3" aria-label="Filtrar minhas tribos">
          {tribes.length > 0 && <>
            <button type="button" onClick={() => setFilter("all")} aria-pressed={filter === "all"} className={`rounded-full px-4 py-2 text-sm font-semibold transition-colors ${filter === "all" ? "bg-primary text-primary-foreground" : "bg-muted text-muted-foreground hover:text-foreground"}`}>Todas</button>
            <button type="button" onClick={() => setFilter("moderator")} aria-pressed={filter === "moderator"} className={`rounded-full px-4 py-2 text-sm font-semibold transition-colors ${filter === "moderator" ? "bg-primary text-primary-foreground" : "bg-muted text-muted-foreground hover:text-foreground"}`}>Sou moderador</button>
            <button type="button" onClick={() => setFilter("participant")} aria-pressed={filter === "participant"} className={`rounded-full px-4 py-2 text-sm font-semibold transition-colors ${filter === "participant" ? "bg-primary text-primary-foreground" : "bg-muted text-muted-foreground hover:text-foreground"}`}>Sou participante</button>
          </>}
        </div>
      )}

      {error && <p role="alert" className="rounded-xl border border-destructive/30 bg-destructive/10 px-4 py-3 text-sm text-destructive">{error}</p>}

      {loading ? (
        <div className="flex justify-center py-16"><LoaderCircle className="size-6 animate-spin text-primary" /></div>
      ) : tribes.length ? (
        <>
          <p className="text-sm text-muted-foreground">{filteredTribes.length} {filteredTribes.length === 1 ? "tribo" : "tribos"}</p>
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {filteredTribes.map((tribe) => (
              <article key={tribe.id} className="flex flex-col rounded-3xl border border-border bg-card p-5 shadow-xs">
                <div className="flex items-center justify-between gap-2">
                  <Badge variant="secondary">{tribe.category}</Badge>
                  <Badge variant="outline">{tribe.isModerator ? "Moderador" : "Participante"}</Badge>
                </div>
                <h2 className="mt-4 font-heading text-lg font-bold">{tribe.name}</h2>
                <p className="mt-2 line-clamp-3 flex-1 whitespace-pre-wrap text-sm leading-relaxed text-muted-foreground">{tribe.description}</p>
                <div className="mt-4 flex flex-wrap gap-x-4 gap-y-2 text-xs text-muted-foreground">
                  <span className="inline-flex items-center gap-1"><MapPin className="size-3.5 text-primary" />{[tribe.neighborhood, tribe.city].filter(Boolean).join(" · ")}</span>
                  <span className="inline-flex items-center gap-1"><Users className="size-3.5 text-primary" />{tribe.memberCount} {tribe.memberCount === 1 ? "membro" : "membros"}</span>
                </div>
                <Button nativeButton={false} render={<Link href={`/tribos/${tribe.id}`} />} className="mt-5 w-full rounded-xl">
                  Abrir tribo<ArrowRight className="size-4" />
                </Button>
              </article>
            ))}
            {!filteredTribes.length && <p className="col-span-full rounded-2xl border border-dashed border-border p-8 text-center text-sm text-muted-foreground">Nenhuma tribo encontrada nesse filtro.</p>}
          </div>
        </>
      ) : (
        <section className="rounded-3xl border border-dashed border-border bg-card px-5 py-14 text-center">
          <div className="mx-auto flex size-12 items-center justify-center rounded-2xl bg-primary/10 text-primary"><Users className="size-6" /></div>
          <h2 className="mt-4 font-heading text-xl font-bold">Você ainda não participa de uma tribo</h2>
          <p className="mx-auto mt-2 max-w-md text-sm text-muted-foreground">Quando entrar ou criar uma comunidade, ela aparecerá aqui.</p>
          <Button nativeButton={false} render={<Link href="/tribos" />} className="mt-5 rounded-xl">Explorar tribos</Button>
        </section>
      )}
    </main>
  );
}
