import { Suspense } from "react";
import { LoaderCircle } from "lucide-react";
import DirectConversationClient from "./conversation-client";

export default function DirectConversationPage() {
  return (
    <Suspense
      fallback={
        <main className="mx-auto flex min-h-72 max-w-3xl items-center justify-center">
          <LoaderCircle className="size-6 animate-spin text-primary" aria-label="Carregando conversa" />
        </main>
      }
    >
      <DirectConversationClient />
    </Suspense>
  );
}
