"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { ArrowRight, Sparkles } from "lucide-react";
import { Navbar } from "@/components/tribes/navbar";
import { Button } from "@/components/ui/button";
import { trackMvpEvent } from "@/lib/mvp-tracker";
import { SiteFooter } from "@/components/tribes/site-footer";
import { AuthLoadingState } from "@/components/social/auth-guard";
import { apiRequest, type Tribe } from "@/lib/social-types";
import { FeaturedHomeTribe, PopularHomeTribes } from "@/components/tribes/home-tribe-highlights";

export default function TribesLandingPage() {
  const router = useRouter();
  const [sessionState, setSessionState] = useState<"loading" | "guest" | "error">("loading");
  const [retryCount, setRetryCount] = useState(0);
  const [tribes, setTribes] = useState<Tribe[]>([]);
  const [tribesLoading, setTribesLoading] = useState(true);
  const [tribesError, setTribesError] = useState("");

  useEffect(() => {
    void trackMvpEvent({ event: "page_view", pagePath: "/" });
  }, []);

  useEffect(() => {
    let active = true;
    fetch("/api/auth/me", { cache: "no-store" })
      .then(async (response) => {
        if (response.status === 401) return { user: null };
        if (!response.ok) throw new Error("session-check-failed");
        return response.json() as Promise<{ user: unknown | null }>;
      })
      .then(({ user }) => {
        if (!active) return;
        if (user) router.replace("/feed");
        else setSessionState("guest");
      })
      .catch(() => { if (active) setSessionState("error"); });
    return () => { active = false; };
  }, [router, retryCount]);

  useEffect(() => {
    let active = true;
    apiRequest<{ tribes: Tribe[] }>("/api/public/tribes", { cache: "no-store" })
      .then(({ tribes: currentTribes }) => { if (active) setTribes(currentTribes); })
      .catch((error: unknown) => {
        if (active) setTribesError(error instanceof Error ? error.message : "Não foi possível carregar as tribos.");
      })
      .finally(() => { if (active) setTribesLoading(false); });
    return () => { active = false; };
  }, []);

  if (sessionState === "loading") return <AuthLoadingState />;
  if (sessionState === "error") return (
    <div className="flex min-h-screen flex-col items-center justify-center gap-4 px-6 text-center">
      <p role="alert" className="max-w-md text-sm text-muted-foreground">Não foi possível confirmar sua sessão agora. Confira sua conexão e tente novamente.</p>
      <Button type="button" onClick={() => { setSessionState("loading"); setRetryCount((count) => count + 1); }}>Tentar novamente</Button>
    </div>
  );

  return (
    <div className="flex min-h-screen flex-col">
      <Navbar />
      <main className="flex-1">
        <section className="relative isolate overflow-hidden bg-background py-12 sm:py-16 lg:py-20">
          <div aria-hidden="true" className="pointer-events-none absolute -top-40 right-[-10%] -z-10 h-[34rem] w-[34rem] rounded-full bg-primary/[0.06] blur-[130px]" />
          <div aria-hidden="true" className="pointer-events-none absolute bottom-[-18rem] left-[-12%] -z-10 h-[34rem] w-[34rem] rounded-full bg-brand-orange/[0.06] blur-[130px]" />
          <div className="mx-auto grid max-w-6xl items-center gap-8 px-4 sm:px-6 lg:grid-cols-12 lg:gap-8">
            <div className="lg:col-span-6">
              <div className="inline-flex items-center gap-2 rounded-full border border-primary/25 bg-primary/8 px-3.5 py-1.5 text-xs font-semibold text-primary">
                <Sparkles className="size-3.5" /> Comunidades. Interesses. Encontros.
              </div>
              <h1 className="mt-5 font-heading text-4xl font-extrabold leading-[1.1] tracking-tight text-foreground sm:text-5xl">
                Encontre sua <span className="text-primary">tribo.</span>
              </h1>
              <p className="mt-5 max-w-xl text-base leading-relaxed text-muted-foreground sm:text-lg">
                Pessoas com os mesmos interesses, atividades que você gosta e encontros de verdade.
              </p>
              <div className="mt-8 flex flex-col gap-3 sm:flex-row sm:items-center">
                <Button size="lg" className="h-12 rounded-full px-7 text-base font-semibold" nativeButton={false} onClick={() => void trackMvpEvent({ event: "hero_cta_click" })} render={<Link href="/cadastro" />}>
                  Começar agora <ArrowRight className="size-4" />
                </Button>
                <Button variant="outline" size="lg" className="h-12 rounded-full px-6 text-base font-semibold" nativeButton={false} render={<Link href="/explorar" />}>
                  Explorar tribos
                </Button>
              </div>

            </div>
            <div className="lg:col-span-6"><FeaturedHomeTribe tribe={tribes[0] ?? null} loading={tribesLoading} error={tribesError} /></div>
          </div>
        </section>
        <section className="relative overflow-hidden bg-background py-12 sm:py-16">
          <div aria-hidden="true" className="pointer-events-none absolute inset-x-0 top-0 h-40 bg-gradient-to-b from-accent/60 to-transparent" />
          <div className="relative mx-auto max-w-6xl px-4 sm:px-6">
            <PopularHomeTribes tribes={tribes} loading={tribesLoading} error={tribesError} />
            <div className="mt-2 text-center">
              <Button variant="outline" className="rounded-full" nativeButton={false} render={<Link href="/explorar" />}>Ver todas as tribos <ArrowRight className="size-4" /></Button>
            </div>
          </div>
        </section>
      </main>
      <SiteFooter />
    </div>
  );
}
