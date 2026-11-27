"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { Bell, CalendarDays, Compass, Flame, LogOut, MessageCircle, UserRound, Users } from "lucide-react";
import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { ThemeToggle } from "@/components/theme/theme-toggle";
import { TribesLogo } from "@/components/tribes/tribes-logo";
import type { CurrentUser } from "@/components/social/auth-guard";
import { UserAvatar } from "@/components/social/user-avatar";

export function SocialHeader({ user }: { user: CurrentUser }) {
  const pathname = usePathname();
  const router = useRouter();
  const [unreadCount, setUnreadCount] = useState(0);
  const [unreadDirectMessages, setUnreadDirectMessages] = useState(0);

  useEffect(() => {
    let active = true;
    const loadUnread = () => {
      void Promise.all([
        fetch("/api/notifications", { cache: "no-store" }).then((response) => response.ok ? response.json() as Promise<{ unreadCount: number }> : null),
        fetch("/api/dm/conversations", { cache: "no-store" }).then((response) => response.ok ? response.json() as Promise<{ conversations: { unreadCount: number }[] }> : null),
      ]).then(([notifications, messages]) => {
        if (!active) return;
        if (notifications) setUnreadCount(notifications.unreadCount);
        if (messages) setUnreadDirectMessages(messages.conversations.reduce((total, conversation) => total + conversation.unreadCount, 0));
      }).catch(() => undefined);
    };
    void loadUnread();
    const handleUpdated = () => void loadUnread();
    window.addEventListener("tribes-notifications-updated", handleUpdated);
    window.addEventListener("tribes-dm-updated", handleUpdated);
    const interval = window.setInterval(() => void loadUnread(), 30000);
    return () => {
      active = false;
      window.clearInterval(interval);
      window.removeEventListener("tribes-notifications-updated", handleUpdated);
      window.removeEventListener("tribes-dm-updated", handleUpdated);
    };
  }, [pathname]);

  async function logout() {
    await fetch("/api/auth/logout", { method: "POST" });
    router.replace("/");
  }

  const nav = [
    { href: "/feed", label: "Feed", icon: Flame },
    { href: "/tribos", label: "Explorar tribos", icon: Compass },
    { href: "/minhas-tribos", label: "Minhas tribos", icon: Users },
    { href: "/mensagens", label: "Mensagens", icon: MessageCircle },
    { href: "/eventos", label: "Eventos", icon: CalendarDays },
  ];

  const isActive = (href: string) => pathname === href || ["/minhas-tribos", "/mensagens"].includes(href) && pathname.startsWith(`${href}/`);

  return (
    <>
    <header className="sticky top-0 z-40 border-b border-border/80 bg-background/90 backdrop-blur-md">
      <div className="mx-auto flex max-w-6xl items-center justify-between gap-2 px-3 py-2.5 sm:gap-3 sm:px-6 sm:py-3">
        <Link href="/feed" className="flex shrink-0 items-center gap-2 font-heading text-lg font-extrabold">
          <TribesLogo />
        </Link>

        <nav aria-label="Navegação principal" className="hidden min-w-0 flex-1 items-center justify-center gap-1 lg:flex xl:gap-2">
          {nav.map((item) => {
            const Icon = item.icon;
            const active = isActive(item.href);
            return (
              <Link key={item.href} href={item.href} aria-current={active ? "page" : undefined}
                className={`inline-flex shrink-0 items-center justify-center gap-2 rounded-xl px-2.5 py-2 text-sm font-semibold transition-colors xl:px-3 ${active ? "bg-primary/10 text-primary" : "text-muted-foreground hover:bg-muted hover:text-foreground"}`}>
                <Icon className="size-4 shrink-0" /><span className="whitespace-nowrap">{item.label}</span>
              </Link>
            );
          })}
        </nav>

        <div className="ml-auto flex shrink-0 items-center gap-1 sm:gap-1.5">
          <ThemeToggle />
          <Link href="/notificacoes" aria-label={unreadCount ? `Notificações, ${unreadCount} não lidas` : "Notificações"} className="relative inline-flex size-9 items-center justify-center rounded-xl text-muted-foreground transition-colors hover:bg-muted hover:text-foreground">
            <Bell className="size-4" />
            {unreadCount > 0 && <span className="absolute -right-0.5 -top-0.5 flex min-w-4 items-center justify-center rounded-full bg-primary px-1 text-[10px] font-bold leading-4 text-primary-foreground">{unreadCount > 99 ? "99+" : unreadCount}</span>}
          </Link>
          <Link href="/mensagens" aria-label={unreadDirectMessages ? `Mensagens, ${unreadDirectMessages} não lidas` : "Mensagens"} className={`relative hidden size-9 items-center justify-center rounded-xl transition-colors hover:bg-muted hover:text-foreground lg:inline-flex ${isActive("/mensagens") ? "text-primary" : "text-muted-foreground"}`}>
            <MessageCircle className="size-4" />
            {unreadDirectMessages > 0 && <span className="absolute -right-0.5 -top-0.5 flex min-w-4 items-center justify-center rounded-full bg-primary px-1 text-[10px] font-bold leading-4 text-primary-foreground">{unreadDirectMessages > 99 ? "99+" : unreadDirectMessages}</span>}
          </Link>
          <Link href="/perfil" aria-label="Meu perfil" className="hidden min-w-0 items-center gap-2 rounded-xl p-1 transition-colors hover:bg-muted lg:flex">
            <UserAvatar name={user.name} avatarUrl={user.avatarUrl} className="size-8 text-xs" />
            <span className="hidden max-w-32 truncate text-xs font-medium text-muted-foreground xl:inline">{user.name}</span>
          </Link>
          <Button variant="ghost" size="icon-sm" aria-label="Sair da conta" onClick={() => void logout()} className="hidden lg:inline-flex"><LogOut className="size-4" /></Button>
        </div>
      </div>
    </header>
    <nav aria-label="Navegação inferior" className="fixed inset-x-0 bottom-0 z-40 grid grid-cols-6 border-t border-border/80 bg-background/95 px-1 pt-2 pb-2 shadow-md backdrop-blur-md lg:hidden" style={{ paddingBottom: "max(env(safe-area-inset-bottom), 0.5rem)" }}>
      {nav.map((item) => {
        const Icon = item.icon;
        const active = isActive(item.href);
        return (
          <Link key={item.href} href={item.href} aria-current={active ? "page" : undefined} className={`flex min-w-0 flex-col items-center justify-center gap-1 rounded-xl px-0.5 py-1 min-h-14 text-[9px] font-semibold leading-[10px] transition-colors sm:text-[10px] ${active ? "bg-primary/10 text-primary" : "text-muted-foreground hover:bg-muted hover:text-foreground"}`}>
            <span className="relative"><Icon className="size-5 shrink-0" />{item.href === "/mensagens" && unreadDirectMessages > 0 && <span className="absolute -right-2 -top-1 size-2 rounded-full bg-primary" aria-label={`${unreadDirectMessages} mensagens não lidas`} />}</span>
            <span className="max-w-full text-center whitespace-normal break-words">{item.href === "/tribos" ? "Explorar tribos" : item.label}</span>
          </Link>
        );
      })}
      <Link href="/perfil" aria-label="Meu perfil" aria-current={pathname === "/perfil" ? "page" : undefined} className={`flex min-w-0 flex-col items-center justify-center gap-1 rounded-xl px-0.5 py-1 text-[8px] font-semibold leading-tight transition-colors sm:text-[9px] ${pathname === "/perfil" ? "bg-primary/10 text-primary" : "text-muted-foreground hover:bg-muted hover:text-foreground"}`}>
        {user.avatarUrl ? <UserAvatar name={user.name} avatarUrl={user.avatarUrl} className="size-5" /> : <UserRound className="size-5 shrink-0" />}
        <span>Perfil</span>
      </Link>
    </nav>
    </>
  );
}
