"use client";

import { usePathname } from "next/navigation";

/**
 * Remounts the active route when the user navigates to another page.
 * This clears page-local form state, drafts and text fields consistently
 * across public and authenticated areas without touching data on the server.
 */
export function RouteStateReset({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();

  return <div key={pathname} className="contents">{children}</div>;
}
