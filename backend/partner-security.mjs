import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";

export const PARTNER_SCOPES = Object.freeze([
  "status:read", "events:read", "events:write", "organizers:write",
  "moderators:read", "moderators:write", "participants:write", "invitations:write",
  "organizer-grants:read",
]);
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const keyPattern = /^tribes_pk_([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.([A-Za-z0-9_-]{43})$/;

export class PartnerError extends Error {
  constructor(statusCode, code, message, headers = {}) {
    super(message);
    this.statusCode = statusCode;
    this.code = code;
    this.headers = headers;
  }
}

export function partnerInvalid(message) {
  return new PartnerError(400, "invalid_payload", message);
}

export function partnerUuid(value) {
  if (typeof value !== "string" || !uuidPattern.test(value)) throw partnerInvalid("Identificador UUID inválido.");
  return value.toLowerCase();
}

export function partnerName(value) {
  if (typeof value !== "string" || value.trim().length < 2 || value.trim().length > 120) {
    throw partnerInvalid("Informe um nome com 2 a 120 caracteres.");
  }
  return value.trim();
}

export function partnerSlug(value) {
  if (typeof value !== "string" || !/^[a-z0-9][a-z0-9_-]{1,79}$/.test(value)) {
    throw partnerInvalid("Slug inválido (2 a 80 caracteres minúsculos, números, _ ou -).");
  }
  return value;
}

export function partnerScopes(value) {
  if (!Array.isArray(value) || value.length < 1 || value.length > PARTNER_SCOPES.length ||
      value.some(scope => !PARTNER_SCOPES.includes(scope)) || new Set(value).size !== value.length) {
    throw partnerInvalid("Informe escopos conhecidos, sem duplicatas.");
  }
  return [...value].sort();
}

export function partnerExpiry(value) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/.test(value)) {
    throw partnerInvalid("A validade deve ser uma data ISO 8601 com fuso horário.");
  }
  const date = new Date(value);
  if (!Number.isFinite(date.getTime()) || date.getTime() <= Date.now()) throw partnerInvalid("A validade deve estar no futuro.");
  // Reject impossible calendar dates that Date would normalize (e.g. February 30).
  const [year, month, day] = value.slice(0, 10).split("-").map(Number);
  const calendar = new Date(Date.UTC(year, month - 1, day));
  if (calendar.getUTCFullYear() !== year || calendar.getUTCMonth() !== month - 1 || calendar.getUTCDate() !== day) {
    throw partnerInvalid("Data de validade inválida.");
  }
  return date.toISOString();
}

export function createPartnerKey() {
  const id = randomUUID();
  const token = `tribes_pk_${id}.${randomBytes(32).toString("base64url")}`;
  return { id, token, tokenHash: digestPartnerKey(token) };
}

export function parsePartnerKey(token) {
  if (typeof token !== "string") return null;
  const match = token.match(keyPattern);
  if (!match || Buffer.from(match[2], "base64url").toString("base64url") !== match[2]) return null;
  return { id: match[1] };
}

export function digestPartnerKey(token) {
  return createHash("sha256").update(token).digest("hex");
}

export function matchesPartnerKey(token, storedHash) {
  const actual = Buffer.from(digestPartnerKey(token), "hex");
  const expected = Buffer.from(storedHash ?? "", "hex");
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

export function readPartnerBearer(request) {
  const header = request.headers.authorization;
  if (typeof header !== "string" || !/^Bearer [^\s]+$/i.test(header)) return null;
  const token = header.slice(7);
  return parsePartnerKey(token) ? token : null;
}
