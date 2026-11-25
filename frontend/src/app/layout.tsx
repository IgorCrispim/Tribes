import type { Metadata } from "next";
import { Suspense } from "react";
import { Plus_Jakarta_Sans, Inter, JetBrains_Mono } from "next/font/google";
import Script from "next/script";
import "./globals.css";
import { ThemeProvider } from "@/components/theme/theme-provider";
import { RouteStateReset } from "@/components/navigation/route-state-reset";

const jakarta = Plus_Jakarta_Sans({
  variable: "--font-heading-sans",
  subsets: ["latin"],
  weight: ["500", "600", "700", "800"],
});

const inter = Inter({
  variable: "--font-body-sans",
  subsets: ["latin"],
});

const jetbrainsMono = JetBrains_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "Tribes",
  description:
    "A rede social feita para conectar pessoas pelos mesmos hobbies e organizar encontros reais, presenciais ou online, sem bagunça no chat.",
  icons: {
    icon: "/tribes-emblem.png",
    shortcut: "/tribes-emblem.png",
    apple: "/tribes-emblem.png",
  },
  openGraph: {
    title: "Tribes",
    description:
      "Descubra comunidades perto de você, entre sem timidez e organize encontros com lista real de presença.",
    images: [{ url: "/tribes-logo.png", width: 456, height: 169, alt: "Tribes" }],
    locale: "pt_BR",
    type: "website",
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html
      lang="pt-BR"
      suppressHydrationWarning
      data-scroll-behavior="smooth"
      className={`${jakarta.variable} ${inter.variable} ${jetbrainsMono.variable} h-full scroll-smooth antialiased`}
    >
      <head>
        <Script id="tribes-theme-init" strategy="beforeInteractive">
          {`try { if (localStorage.getItem("tribes-theme") === "dark") document.documentElement.classList.add("dark"); } catch {}`}
        </Script>
      </head>
      <body className="min-h-full flex flex-col bg-background text-foreground selection:bg-primary/15 selection:text-primary">
        <ThemeProvider>
          <Suspense fallback={<div className="min-h-screen" aria-hidden="true" />}>
            <RouteStateReset>{children}</RouteStateReset>
          </Suspense>
        </ThemeProvider>
      </body>
    </html>
  );
}
