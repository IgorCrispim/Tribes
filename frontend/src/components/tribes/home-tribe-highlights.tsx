import Link from "next/link";
import { ArrowRight, MapPin, Users } from "lucide-react";
import { Button } from "@/components/ui/button";
import { type Tribe } from "@/lib/social-types";

function tribeLocation(tribe: Tribe) {
  return [tribe.neighborhood, tribe.city].filter(Boolean).join(" · ");
}

function memberLabel(count: number) {
  return `${count} ${count === 1 ? "membro" : "membros"}`;
}

export function FeaturedHomeTribe({ tribe, loading, error }: { tribe: Tribe | null; loading: boolean; error: string }) {
  return (
    <div className="relative mx-auto w-full max-w-xl">
      <div aria-hidden="true" className="pointer-events-none absolute -inset-4 -z-10 rounded-4xl bg-gradient-to-tr from-primary/20 via-orange-500/10 to-transparent blur-2xl" />
      <article className="overflow-hidden rounded-3xl border border-border bg-card shadow-[0_16px_40px_rgba(48,66,45,0.09)] ring-1 ring-white/[0.04]">
        <div className="border-b border-border bg-muted/70 px-5 py-4">
          <p className="text-xs font-bold uppercase tracking-[0.16em] text-primary">Tribo com mais membros</p>
          {loading ? (
            <div className="mt-3 space-y-2" aria-label="Carregando tribo em destaque">
              <div className="h-6 w-3/4 animate-pulse rounded bg-foreground/10" />
              <div className="h-4 w-1/2 animate-pulse rounded bg-foreground/10" />
            </div>
          ) : tribe ? (
            <>
              <h2 className="mt-2 break-words font-heading text-2xl font-extrabold text-foreground">{tribe.name}</h2>
              <p className="mt-1 text-sm text-muted-foreground">{tribe.category} · {tribe.format}</p>
            </>
          ) : (
            <p className="mt-2 text-sm text-muted-foreground">{error ? "Não foi possível carregar as comunidades agora." : "Ainda não há tribos abertas."}</p>
          )}
        </div>

        {tribe && !loading ? (
          <div className="space-y-4 p-5 sm:p-6">
            <div className="flex flex-wrap items-center justify-between gap-3">
              {tribeLocation(tribe) && <span className="inline-flex items-center gap-1.5 text-sm text-muted-foreground"><MapPin className="size-4 text-primary" />{tribeLocation(tribe)}</span>}
              <span className="inline-flex items-center gap-1.5 rounded-full border border-primary/25 bg-primary/10 px-3 py-1.5 text-sm font-semibold text-primary"><Users className="size-4" />{memberLabel(tribe.memberCount)}</span>
            </div>
            <p className="line-clamp-4 text-sm leading-relaxed text-foreground/80">{tribe.description}</p>
            <Button className="w-full rounded-xl" nativeButton={false} render={<Link href={`/tribos/${tribe.id}`} />}>
              Conhecer tribo <ArrowRight className="size-4" />
            </Button>
          </div>
        ) : loading ? (
          <div className="space-y-3 p-5" aria-hidden="true">
            <div className="h-4 w-2/3 animate-pulse rounded bg-foreground/10" />
            <div className="h-16 w-full animate-pulse rounded-xl bg-foreground/10" />
            <div className="h-10 w-full animate-pulse rounded-xl bg-foreground/10" />
          </div>
        ) : null}
      </article>
    </div>
  );
}

export function PopularHomeTribes({ tribes, loading, error }: { tribes: Tribe[]; loading: boolean; error: string }) {
  return (
    <section className="rounded-3xl border border-border bg-gradient-to-br from-background via-card to-muted/40 px-4 py-7 shadow-[0_10px_30px_rgba(65,35,30,0.045)] sm:px-6 sm:py-8">
      <div className="mb-6">
        <p className="text-xs font-bold uppercase tracking-[0.18em] text-primary">Comunidades abertas</p>
        <h2 className="mt-1 font-heading text-2xl font-extrabold text-foreground">Tribos com mais membros</h2>
        <p className="mt-1 text-sm text-muted-foreground">Ordenadas pelo número atual de membros.</p>
      </div>

      {error ? (
        <p role="alert" className="rounded-xl border border-destructive/30 bg-destructive/10 px-4 py-3 text-sm text-destructive">{error}</p>
      ) : loading ? (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3" aria-label="Carregando tribos">
          {[0, 1, 2].map((item) => <div key={item} className="h-48 animate-pulse rounded-2xl bg-muted" />)}
        </div>
      ) : tribes.length ? (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {tribes.map((tribe, index) => (
            <Link key={tribe.id} href={`/tribos/${tribe.id}`} className="group flex h-full flex-col rounded-2xl border border-border bg-card p-5 transition-all hover:-translate-y-1 hover:border-primary/35 hover:shadow-lg">
              <div className="flex items-center justify-between gap-3">
                <span className="rounded-full bg-primary/10 px-3 py-1 text-xs font-semibold text-primary">#{index + 1} · {tribe.category}</span>
                <span className="text-xs font-medium text-muted-foreground">{tribe.format}</span>
              </div>
              <h3 className="mt-4 break-words font-heading text-lg font-bold text-foreground transition-colors group-hover:text-primary">{tribe.name}</h3>
              <p className="mt-2 line-clamp-2 flex-1 text-sm text-muted-foreground">{tribe.description}</p>
              <div className="mt-4 flex flex-wrap items-center justify-between gap-2 border-t border-border pt-3 text-xs text-muted-foreground">
                {tribeLocation(tribe) ? <span className="inline-flex items-center gap-1"><MapPin className="size-3.5 text-primary" />{tribeLocation(tribe)}</span> : <span />}
                <span className="inline-flex items-center gap-1 font-semibold text-primary"><Users className="size-3.5" />{memberLabel(tribe.memberCount)}</span>
              </div>
            </Link>
          ))}
        </div>
      ) : (
        <div className="rounded-2xl border border-dashed border-border px-5 py-10 text-center">
          <h3 className="font-heading text-lg font-bold">Ainda não há tribos abertas</h3>
          <p className="mt-2 text-sm text-muted-foreground">Volte em breve para descobrir comunidades por aqui.</p>
        </div>
      )}
    </section>
  );
}
