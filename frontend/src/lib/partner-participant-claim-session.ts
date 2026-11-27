const KEY = "tribes-participant-claim-session";
const MAX_AGE_MS = 60 * 60 * 1000;
const AUTH_CHANNEL = "tribes-social-session";
const AUTH_SIGNAL_KEY = "tribes-social-session-ready";

export type ParticipantClaimPreview = {
  confirmationToken: string;
  expiresAt: string;
  partner: { name: string; slug: string };
  application: { name: string; slug: string };
  participant: { id: string; externalParticipantId: string };
  event: { externalEventId: string; title: string };
  socialTribe: { id: string; name: string; isPrivate: boolean };
};

type ClaimSession = { claimToken: string; preview?: ParticipantClaimPreview; savedAt: number };

function read(): ClaimSession | null {
  try {
    const value = sessionStorage.getItem(KEY);
    if (!value) return null;
    const parsed = JSON.parse(value) as ClaimSession;
    if (!parsed || typeof parsed.claimToken !== "string" || Date.now() - parsed.savedAt > MAX_AGE_MS) {
      sessionStorage.removeItem(KEY);
      return null;
    }
    return parsed;
  } catch { return null; }
}

export function getParticipantClaimSession() { return read(); }

export function saveParticipantClaimToken(claimToken: string) {
  try { sessionStorage.setItem(KEY, JSON.stringify({ claimToken, savedAt: Date.now() } satisfies ClaimSession)); }
  catch { /* Sem sessão temporária não prosseguimos com o resgate. */ }
}

export function saveParticipantClaimPreview(preview: ParticipantClaimPreview) {
  const current = read();
  if (!current) return;
  try { sessionStorage.setItem(KEY, JSON.stringify({ ...current, preview } satisfies ClaimSession)); }
  catch { /* Os dados também permanecem na memória da página atual. */ }
}

export function clearParticipantClaimSession() {
  try { sessionStorage.removeItem(KEY); } catch { /* Sessão temporária indisponível. */ }
}

export function notifySocialSessionReady() {
  if (typeof BroadcastChannel !== "undefined") {
    try {
      const channel = new BroadcastChannel(AUTH_CHANNEL);
      channel.postMessage("session-ready");
      channel.close();
      return;
    } catch { /* Fall back when the browser exposes but disables BroadcastChannel. */ }
  }
  // This value is only a notification marker; claim tokens and confirmation
  // data remain in the originating tab's sessionStorage.
  try { localStorage.setItem(AUTH_SIGNAL_KEY, `${Date.now()}-${Math.random()}`); }
  catch { /* The waiting tab also polls the shared authenticated session. */ }
}

export function onSocialSessionReady(callback: () => void) {
  let active = true;
  let notified = false;
  let pollTimer: number | undefined;
  let channel: BroadcastChannel | undefined;
  const notify = () => {
    if (!active || notified) return;
    notified = true;
    if (pollTimer !== undefined) window.clearInterval(pollTimer);
    callback();
  };

  if (typeof BroadcastChannel !== "undefined") {
    try {
      channel = new BroadcastChannel(AUTH_CHANNEL);
      channel.onmessage = event => {
        if (event.data === "session-ready") notify();
      };
    } catch { /* Use the storage/session fallback below. */ }
  }
  if (!channel) {
    const handleStorage = (event: StorageEvent) => {
      if (event.key === AUTH_SIGNAL_KEY && event.newValue !== null) notify();
    };
    window.addEventListener("storage", handleStorage);

    // sessionStorage is intentionally tab-scoped. If localStorage is blocked,
    // the cookie shared by same-origin tabs still lets this tab detect login
    // without copying a claim or confirmation secret between tabs.
    const checkSession = async () => {
      try {
        const response = await fetch("/api/auth/me", { cache: "no-store", referrerPolicy: "no-referrer" });
        if (!response.ok) return;
        const result = await response.json();
        if (result.user) notify();
      } catch { /* Authentication can be retried on the next interval. */ }
    };
    void checkSession();
    pollTimer = window.setInterval(() => void checkSession(), 2000);

    return () => {
      active = false;
      if (pollTimer !== undefined) window.clearInterval(pollTimer);
      window.removeEventListener("storage", handleStorage);
    };
  }

  return () => {
    active = false;
    channel?.close();
  };
}
