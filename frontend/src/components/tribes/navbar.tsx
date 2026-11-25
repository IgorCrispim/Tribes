"use client";

import { Suspense, useEffect, useState } from "react";
import { createPortal } from "react-dom";
import Link from "next/link";
import Image from "next/image";
import { usePathname } from "next/navigation";
import { Menu, X, ArrowRight, LogIn } from "lucide-react";
import { Button } from "@/components/ui/button";
import { ThemeToggle } from "@/components/theme/theme-toggle";

const NAV_LINKS = [
  { href: "/explorar", label: "Explorar tribos" },
];

export function Navbar() {
  return (
    <Suspense fallback={<NavbarFallback />}>
      <NavbarContent />
    </Suspense>
  );
}

function NavbarContent() {
  const [mobileOpen, setMobileOpen] = useState(false);
  const pathname = usePathname();

  useEffect(() => {
    if (!mobileOpen) return;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setMobileOpen(false);
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => {
      document.body.style.overflow = previousOverflow;
      window.removeEventListener("keydown", handleKeyDown);
    };
  }, [mobileOpen]);

  return (
    <>
    <header className="sticky top-0 z-40 w-full border-b border-border/70 bg-background/90 backdrop-blur-md">
      <div className="mx-auto flex h-[68px] max-w-7xl items-center justify-between gap-4 px-4 sm:px-6 lg:px-8">
        <Link href="/" aria-label="Tribes — página inicial" className="flex shrink-0 items-center">
          <span className="relative h-10 w-[7.25rem] shrink-0 overflow-hidden">
            <Image src="/tribes-logo.png" alt="Tribes — Comunidade e Natureza" fill priority sizes="116px" className="object-cover object-[center_40%]" />
          </span>
        </Link>
        <nav aria-label="Navegação principal" className="hidden items-center gap-6 lg:flex">
          {NAV_LINKS.map((item) => (
            <Link key={item.href} href={item.href} aria-current={pathname === item.href ? "page" : undefined}
              className={`relative py-2 text-[13px] font-semibold transition-colors hover:text-foreground ${pathname === item.href ? "text-primary after:absolute after:inset-x-0 after:-bottom-[2px] after:h-[3px] after:rounded-full after:bg-primary" : "text-muted-foreground"}`}>
              {item.label}
            </Link>
          ))}
        </nav>
        <div className="hidden items-center gap-2 lg:flex">
          <ThemeToggle />
          <Button size="lg" className="rounded-full px-4 font-semibold" nativeButton={false} render={<Link href="/cadastro" />}>
            Começar <ArrowRight className="size-4" />
          </Button>
          <Button variant="ghost" size="sm" nativeButton={false} render={<Link href="/entrar" />}>
            <LogIn className="size-4" /> Entrar
          </Button>
        </div>
        <button type="button" aria-label={mobileOpen ? "Fechar menu" : "Abrir menu"} onClick={() => setMobileOpen((prev) => !prev)}
          className="inline-flex size-10 items-center justify-center rounded-xl border border-border bg-card text-foreground lg:hidden">
          {mobileOpen ? <X className="size-5" /> : <Menu className="size-5" />}
        </button>
      </div>
    </header>
    {mobileOpen && createPortal(
      <div className="fixed inset-0 z-[100] lg:hidden">
        <button type="button" aria-label="Fechar menu" onClick={() => setMobileOpen(false)} className="absolute inset-0 bg-black/50" />
        <aside role="dialog" aria-modal="true" aria-label="Menu principal" className="absolute inset-y-0 right-0 flex h-[100dvh] w-[min(20rem,86vw)] flex-col overflow-y-auto border-l border-border bg-background p-5 shadow-2xl">
          <div className="flex shrink-0 items-center justify-between border-b border-border pb-4">
            <span className="font-heading text-lg font-bold">Menu</span>
            <button type="button" aria-label="Fechar menu" onClick={() => setMobileOpen(false)} className="inline-flex size-9 items-center justify-center rounded-xl hover:bg-muted"><X className="size-5" /></button>
          </div>
          <nav className="flex flex-1 flex-col gap-1 py-5">
            {NAV_LINKS.map((item) => (
              <Link key={item.href} href={item.href} onClick={() => setMobileOpen(false)} aria-current={pathname === item.href ? "page" : undefined} className={`rounded-xl px-3 py-3 text-sm font-semibold transition-colors ${pathname === item.href ? "bg-primary/10 text-primary" : "text-muted-foreground hover:bg-muted hover:text-foreground"}`}>{item.label}</Link>
            ))}
          </nav>
          <div className="mt-auto flex shrink-0 flex-col gap-2 border-t border-border pt-4">
            <ThemeToggle showLabel className="w-full justify-start" />
            <Link href="/entrar" onClick={() => setMobileOpen(false)} className="flex min-h-11 items-center gap-2 rounded-xl px-3 py-3 text-sm font-semibold text-foreground hover:bg-muted">
              <LogIn className="size-4" /> Entrar
            </Link>
            <Button size="lg" className="w-full rounded-full font-semibold" nativeButton={false} onClick={() => setMobileOpen(false)} render={<Link href="/cadastro" />}>
              Começar <ArrowRight className="size-4" />
            </Button>
          </div>
        </aside>
      </div>,
      document.body
    )}
    </>
  );
}

function NavbarFallback() {
  return (
    <header
      className="sticky top-0 z-40 w-full border-b border-border/70 bg-background/90 backdrop-blur-md"
      aria-hidden="true"
    >
      <div className="mx-auto flex h-[68px] max-w-7xl items-center justify-between gap-4 px-4 sm:px-6 lg:px-8">
        <span className="relative h-10 w-[7.25rem] shrink-0 overflow-hidden">
          <Image src="/tribes-logo.png" alt="" fill priority sizes="116px" className="object-cover object-[center_40%]" />
        </span>
        <div className="size-10 animate-pulse rounded-xl bg-muted lg:hidden" />
        <div className="hidden h-9 w-40 animate-pulse rounded-full bg-muted lg:block" />
      </div>
    </header>

  );
}
