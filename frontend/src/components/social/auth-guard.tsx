"use client";

import { createContext, useContext, useEffect, useRef, useState } from "react";
import Image from "next/image";
import { usePathname, useRouter } from "next/navigation";
import { SocialHeader } from "@/components/social/social-header";
import { Button } from "@/components/ui/button";

const MOBILE_NAVIGATION_PATHS = ["/feed", "/tribos", "/minhas-tribos", "/mensagens", "/eventos", "/perfil"];

export interface CurrentUser {
  id: string;
  name: string;
  email: string;
  aboutMe: string;
  city: string;
  interests: string[];
  profileVisibility: { aboutMe: "public" | "private"; city: "public" | "private"; interests: "public" | "private" };
  avatarUrl: string | null;
}

const EMPTY_CURRENT_USER: CurrentUser = {
  id: "",
  name: "",
  email: "",
  aboutMe: "",
  city: "",
  interests: [],
  profileVisibility: { aboutMe: "private", city: "private", interests: "private" },
  avatarUrl: null,
};

const CurrentUserContext = createContext<{
  user: CurrentUser;
  setUser: React.Dispatch<React.SetStateAction<CurrentUser | null>>;
} | null>(null);

export function useCurrentUser() {
  const context = useContext(CurrentUserContext);
  if (!context) throw new Error("useCurrentUser deve ser usado dentro de AuthGuard.");
  return context;
}

export function AuthLoadingState() {
  return (
    <div className="flex min-h-screen items-center justify-center text-primary">
      <Image src="/tribes-emblem.png" alt="Carregando Tribes" width={32} height={32} className="size-8 animate-pulse object-contain" loading="eager" />
    </div>
  );
}

export function AuthGuard({ children }: { children: React.ReactNode }) {
  const [user, setUser] = useState<CurrentUser | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [authError, setAuthError] = useState(false);
  const [retryCount, setRetryCount] = useState(0);
  const pathname = usePathname();
  const router = useRouter();
  const touchStart = useRef<{ x: number; y: number; startedAt: number } | null>(null);

  function handleTouchStart(event: React.TouchEvent<HTMLDivElement>) {
    if (event.touches.length !== 1) {
      touchStart.current = null;
      return;
    }

    const target = event.target;
    if (!(target instanceof Element) || target.closest("a, button, input, textarea, select, [role='button'], [contenteditable='true'], [data-no-swipe]")) {
      touchStart.current = null;
      return;
    }

    for (let element: HTMLElement | null = target as HTMLElement; element && element !== event.currentTarget; element = element.parentElement) {
      const style = window.getComputedStyle(element);
      if ((style.overflowX === "auto" || style.overflowX === "scroll") && element.scrollWidth > element.clientWidth) {
        touchStart.current = null;
        return;
      }
    }

    const touch = event.touches[0];
    touchStart.current = { x: touch.clientX, y: touch.clientY, startedAt: Date.now() };
  }

  function handleTouchEnd(event: React.TouchEvent<HTMLDivElement>) {
    const start = touchStart.current;
    touchStart.current = null;
    if (!start || !window.matchMedia("(max-width: 1023px)").matches) return;

    const touch = event.changedTouches[0];
    if (!touch) return;

    const deltaX = touch.clientX - start.x;
    const deltaY = touch.clientY - start.y;
    if (Math.abs(deltaX) < 64 || Math.abs(deltaX) < Math.abs(deltaY) * 1.3 || Date.now() - start.startedAt > 800) return;

    const currentIndex = MOBILE_NAVIGATION_PATHS.findIndex((path) => pathname === path || pathname.startsWith(`${path}/`));
    if (currentIndex < 0) return;

    const nextIndex = currentIndex + (deltaX < 0 ? 1 : -1);
    const nextPath = MOBILE_NAVIGATION_PATHS[nextIndex];
    if (nextPath) router.push(nextPath);
  }

  useEffect(() => {
    let active = true;
    fetch("/api/auth/me", { cache: "no-store" })
      .then(async (response) => {
        if (response.status === 401) {
          if (active) router.replace(`/entrar?next=${encodeURIComponent(pathname)}`);
          return null;
        }
        if (!response.ok) throw new Error("session-check-failed");
        return response.json() as Promise<{ user: CurrentUser | null }>;
      })
      .then((result) => {
        if (!active) return;
        if (!result) return;
        const { user: authenticatedUser } = result;
        if (!authenticatedUser) {
          router.replace(`/entrar?next=${encodeURIComponent(pathname)}`);
          return;
        }
        setUser(authenticatedUser);
        setLoaded(true);
      })
      .catch(() => {
        if (active) setAuthError(true);
      });
    return () => { active = false; };
  }, [pathname, retryCount, router]);

  return (
    <div className="min-h-screen bg-background">
      {user && (
        <CurrentUserContext.Provider value={{ user, setUser }}>
          <SocialHeader user={user} />
        </CurrentUserContext.Provider>
      )}
      <div
        hidden={!loaded || !user}
        aria-hidden={!loaded || !user}
        className="mx-auto max-w-6xl px-4 pt-6 pb-[calc(5rem+env(safe-area-inset-bottom))] sm:px-6 sm:pt-9 lg:pb-9"
        onTouchStart={handleTouchStart}
        onTouchEnd={handleTouchEnd}
        onTouchCancel={() => { touchStart.current = null; }}
      >
        <CurrentUserContext.Provider value={{ user: user ?? EMPTY_CURRENT_USER, setUser }}>
          {children}
        </CurrentUserContext.Provider>
      </div>
      {!loaded && authError && !user && (
        <div className="flex min-h-screen flex-col items-center justify-center gap-4 px-6 text-center">
          <p role="alert" className="max-w-md text-sm text-muted-foreground">
            Não foi possível confirmar sua sessão agora. Confira sua conexão e tente novamente.
          </p>
          <Button type="button" onClick={() => { setAuthError(false); setRetryCount((count) => count + 1); }}>Tentar novamente</Button>
        </div>
      )}
      {(!loaded || !user) && !(authError && !user) && <AuthLoadingState />}
    </div>
  );
}
