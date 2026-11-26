const KEY = "tribes-invitation-token";

export function getInvitationToken() {
  try { return sessionStorage.getItem(KEY); } catch { return null; }
}

export function setInvitationToken(token: string) {
  try { sessionStorage.setItem(KEY, token); } catch { /* A confirmação de cadastro ainda pode associar convites ao e-mail. */ }
}

export function clearInvitationToken() {
  try { sessionStorage.removeItem(KEY); } catch { /* Armazenamento indisponível. */ }
}
