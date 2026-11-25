export interface SocialUser {
  id: string;
  name: string;
  email: string;
  aboutMe: string;
  avatarUrl: string | null;
}

export interface Tribe {
  id: string;
  name: string;
  description: string;
  category: string;
  format: "Presencial" | "Híbrido" | "Online";
  city: string;
  neighborhood: string;
  createdAt: string;
  memberCount: number;
  isMember: boolean;
  isModerator?: boolean;
}

export interface FeedItem {
  id: string;
  type: "post" | "event" | "poll";
  body: string;
  imageUrl: string | null;
  createdAt: string;
  editedAt: string | null;
  author: { id: string; name: string; avatarUrl: string | null };
  isMine: boolean;
  tribe: { id: string; name: string };
  likesCount: number;
  commentsCount: number;
  likedByMe: boolean;
  savedByMe: boolean;
  poll: null | { options: { id: string; label: string; votes: number }[]; totalVotes: number; votedOptionIds: string[]; multiple: boolean };
  event: null | {
    title: string;
    startsAt: string;
    endsAt: string | null;
    location: string;
    lat: number | null;
    lon: number | null;
    cost: string;
    maxAttendees: number | null;
    attendeesCount: number;
    attendingByMe: boolean;
    waitlistCount: number;
    waitlistedByMe: boolean;
  };
}

export interface FeedComment {
  id: string;
  body: string;
  createdAt: string;
  editedAt: string | null;
  likesCount: number;
  likedByMe: boolean;
  isMine: boolean;
  author: { id: string; name: string; avatarUrl: string | null };
}

export interface PublicProfile {
  id: string;
  name: string;
  aboutMe: string;
  city: string;
  interests: string[];
  avatarUrl: string | null;
  isMe: boolean;
}

export async function apiRequest<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, {
    ...init,
    headers: {
      ...(init?.body ? { "Content-Type": "application/json" } : {}),
      ...init?.headers,
    },
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    const message = payload.error === "Origem da requisição não permitida."
      ? "Não foi possível validar a origem desta solicitação. Atualize a página e tente novamente. Se continuar, verifique a configuração do endereço do site."
      : payload.error === "Invalid time value"
        ? "Uma data informada é inválida. Confira a data e o horário e tente novamente."
        : payload.error ?? "Não foi possível completar a solicitação.";
    throw new Error(message);
  }
  return payload as T;
}

export function formatDateTime(value: string | null | undefined) {
  if (!value) return "Data indisponível";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "Data indisponível";
  return new Intl.DateTimeFormat("pt-BR", {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(date);
}
