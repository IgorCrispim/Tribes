import { partnerInvalid } from "./partner-security.mjs";

const formats = new Set(["Presencial", "Híbrido", "Online"]);

function objectWithKeys(value, allowed) {
  if (!value || typeof value !== "object" || Array.isArray(value) ||
      Object.keys(value).some(key => !allowed.includes(key))) {
    throw partnerInvalid("Objeto ou campos do recurso inválidos.");
  }
}

function externalId(value, label) {
  if (typeof value !== "string" || value.length < 1 || value.length > 128 ||
      value !== value.trim() || /[\u0000-\u001f\u007f]/u.test(value)) {
    throw partnerInvalid(`Identificador externo de ${label} inválido (1 a 128 caracteres, sem espaços externos ou controles).`);
  }
  return value;
}

export function parsePartnerClaimToken(value) {
  if (typeof value !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(value) ||
      Buffer.from(value, "base64url").toString("base64url") !== value ||
      Buffer.from(value, "base64url").length !== 32) {
    throw partnerInvalid("O segredo de resgate deve conter 32 bytes aleatórios em base64url.");
  }
  return value;
}

export function parsePartnerParticipant(value) {
  objectWithKeys(value, ["claimToken"]);
  return { claimToken: parsePartnerClaimToken(value.claimToken) };
}

function requiredString(value, label, min, max) {
  if (typeof value !== "string" || value.trim().length < min || value.trim().length > max) {
    throw partnerInvalid(`Informe ${label} com ${min} a ${max} caracteres.`);
  }
  return value.trim();
}

function eventTimestamp(value, label) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/.test(value)) {
    throw partnerInvalid(`${label} deve ser uma data ISO 8601 com fuso horário.`);
  }
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) throw partnerInvalid(`${label} inválida.`);
  const [year, month, day] = value.slice(0, 10).split("-").map(Number);
  const calendarDate = new Date(Date.UTC(year, month - 1, day));
  if (calendarDate.getUTCFullYear() !== year || calendarDate.getUTCMonth() !== month - 1 || calendarDate.getUTCDate() !== day) {
    throw partnerInvalid(`${label} inválida.`);
  }
  return date.toISOString();
}

export function parsePartnerTribe(value, { externalTribeId, creating = false } = {}) {
  objectWithKeys(value, creating
    ? ["externalTribeId", "name", "description", "category", "format", "city", "neighborhood"]
    : ["name", "description", "category", "format", "city", "neighborhood"]);
  const format = value.format;
  if (!formats.has(format)) throw partnerInvalid("Formato de tribo inválido.");
  const neighborhood = value.neighborhood === undefined ? "" : requiredString(value.neighborhood, "bairro", 0, 100);
  const tribe = {
    name: requiredString(value.name, "nome da tribo", 2, 80),
    description: requiredString(value.description, "descrição da tribo", 2, 1000),
    category: requiredString(value.category, "categoria", 2, 60),
    format,
    city: requiredString(value.city, "cidade", 2, 100),
    neighborhood,
  };
  if (creating) tribe.externalTribeId = externalId(value.externalTribeId, "tribo");
  else tribe.externalTribeId = externalId(externalTribeId, "tribo");
  return tribe;
}

export function parsePartnerEvent(value, { creating = false } = {}) {
  const keys = ["externalTribeId", "title", "description", "startsAt", "endsAt", "location", "lat", "lon", "cost", "maxAttendees"];
  if (creating) keys.push("externalEventId");
  objectWithKeys(value, keys);
  const startsAt = eventTimestamp(value.startsAt, "Data de início");
  const endsAt = value.endsAt == null || value.endsAt === "" ? null : eventTimestamp(value.endsAt, "Data de término");
  if (endsAt && Date.parse(endsAt) <= Date.parse(startsAt)) throw partnerInvalid("A data de término deve ser posterior ao início.");
  const maxAttendees = value.maxAttendees == null || value.maxAttendees === "" ? null : value.maxAttendees;
  if (maxAttendees !== null && (!Number.isInteger(maxAttendees) || maxAttendees < 1 || maxAttendees > 10000)) {
    throw partnerInvalid("Limite de participantes inválido (1 a 10000).");
  }
  const lat = value.lat == null ? null : value.lat;
  const lon = value.lon == null ? null : value.lon;
  if ((lat === null) !== (lon === null) || (lat !== null && (typeof lat !== "number" || !Number.isFinite(lat) || lat < -90 || lat > 90)) ||
      (lon !== null && (typeof lon !== "number" || !Number.isFinite(lon) || lon < -180 || lon > 180))) {
    throw partnerInvalid("Coordenadas inválidas; informe latitude e longitude válidas em conjunto.");
  }
  const cost = value.cost === undefined ? "" : requiredString(value.cost, "custo", 0, 100);
  const event = {
    externalTribeId: externalId(value.externalTribeId, "tribo"),
    title: requiredString(value.title, "título do evento", 2, 120),
    description: requiredString(value.description, "descrição do evento", 1, 5000),
    startsAt, endsAt,
    location: requiredString(value.location, "local", 2, 240),
    lat, lon, cost, maxAttendees,
  };
  if (creating) event.externalEventId = externalId(value.externalEventId, "evento");
  return event;
}

export function parseExternalResourceId(value, label) {
  return externalId(value, label);
}
