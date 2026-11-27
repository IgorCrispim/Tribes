import { randomUUID } from "node:crypto";
import { readJson, sendJson } from "./http-utils.mjs";
import { PartnerError, readPartnerBearer } from "./partner-security.mjs";
import { parsePartnerEvent, parsePartnerTribe, parsePartnerParticipant, parseExternalResourceId } from "./partner-resources.mjs";
import { partnerStore } from "./partner-store.mjs";

const prefix = "/api/v1/partners";
const routeNotFound = () => ({ status: 404, code: "route_not_found", error: "Rota de integração não encontrada." });
const methodNotAllowed = allow => ({ status: 405, code: "method_not_allowed", error: "Método não permitido.", headers: { Allow: allow } });

async function readPartnerJson(request) {
  try {
    return await readJson(request, { maxSize: 16 * 1024, requireObject: true, invalidMessage: "Objeto JSON inválido." });
  } catch (error) {
    if (error instanceof PartnerError) throw error;
    throw new PartnerError(error.statusCode ?? 400, "invalid_payload", error.message ?? "Objeto JSON inválido.");
  }
}

function externalPathId(encoded, label) {
  try { return parseExternalResourceId(decodeURIComponent(encoded), label); }
  catch (error) {
    if (error instanceof PartnerError) throw error;
    throw new PartnerError(400, "invalid_payload", `Identificador externo de ${label} inválido.`);
  }
}

function resolveRoute(pathname, method) {
  if (pathname === `${prefix}/status`) return { kind: "status", scopes: ["status:read"], allow: "GET" };
  if (pathname === `${prefix}/tribes`) return { kind: "tribes", scopes: ["organizers:write"], allow: "POST" };
  if (pathname === `${prefix}/events`) return { kind: "events", scopes: ["events:write"], allow: "POST" };
  const organizerGrants = pathname.match(new RegExp(`^${prefix}/tribes/([^/]+)/organizer-grants$`));
  if (organizerGrants) return { kind: "organizerGrants", id: organizerGrants[1], scopes: ["organizer-grants:read"], allow: "GET" };
  const eventCancel = pathname.match(new RegExp(`^${prefix}/events/([^/]+)/cancel$`));
  if (eventCancel) return { kind: "eventCancel", id: eventCancel[1], scopes: ["events:write"], allow: "POST" };
  const participantClaim = pathname.match(new RegExp(`^${prefix}/events/([^/]+)/participants/([^/]+)/claim-token$`));
  if (participantClaim) return { kind: "participantClaimToken", eventId: participantClaim[1], participantId: participantClaim[2], scopes: ["participants:write"], allow: "PUT" };
  const participant = pathname.match(new RegExp(`^${prefix}/events/([^/]+)/participants/([^/]+)$`));
  if (participant) return { kind: "participant", eventId: participant[1], participantId: participant[2], scopes: ["participants:write"], allow: "POST, DELETE" };
  const tribe = pathname.match(new RegExp(`^${prefix}/tribes/([^/]+)$`));
  if (tribe) return { kind: "tribe", id: tribe[1], scopes: ["organizers:write"], allow: "GET, PATCH" };
  const event = pathname.match(new RegExp(`^${prefix}/events/([^/]+)$`));
  if (event) return { kind: "event", id: event[1], scopes: method === "GET" ? ["events:read"] : ["events:write"], allow: "GET, PATCH" };
  return null;
}

// Invalid authentication attempts only. Valid integrations share the persistent
// per-application limit. Never trust caller-supplied X-Forwarded-For here.
export function createPartnerAuthLimiter({ now = Date.now, maxEntries = 10000, limit = 30 } = {}) {
  const attempts = new Map();
  function prune(time) {
    if (attempts.size >= maxEntries) {
      for (const [key, value] of attempts) if (value.until <= time) attempts.delete(key);
    }
  }
  return {
    blocked(ip) {
      const time = now();
      prune(time);
      const current = attempts.get(ip);
      return (current?.until > time && current.count >= limit) || (!current && attempts.size >= maxEntries);
    },
    record(ip) {
      const time = now();
      prune(time);
      const current = attempts.get(ip);
      if (current?.until > time) current.count += 1;
      else if (attempts.size < maxEntries || current) attempts.set(ip, { count: 1, until: time + 60000 });
    },
  };
}

export function createPartnerRequestHandler({ store = partnerStore, authLimiter = createPartnerAuthLimiter(), logError = console.error } = {}) {
  return async function handlePartnerRequest(request, response, url) {
    if (url.pathname !== prefix && !url.pathname.startsWith(`${prefix}/`)) return false;
    const requestId = randomUUID();
    response.setHeader("X-Request-Id", requestId);
    const fail = (status, code, error, headers = {}) => sendJson(response, status, { error, code, requestId }, headers);
    const ip = request.socket.remoteAddress ?? "local";
    if (authLimiter.blocked(ip)) {
      fail(429, "authentication_rate_limit", "Muitas tentativas de autenticação.", { "Retry-After": "60" });
      return true;
    }
    // This is a server-to-server API; it has no browser CORS or cookie flow.
    if (request.headers.origin) {
      fail(403, "server_to_server_only", "Esta API exige integração server-to-server.");
      return true;
    }
    const authorizationHeaders = (request.rawHeaders ?? []).filter((_, index, values) => index % 2 === 0 && values[index].toLowerCase() === "authorization");
    const token = authorizationHeaders.length > 1 ? null : readPartnerBearer(request);
    if (!token) {
      authLimiter.record(ip);
      fail(401, "invalid_credentials", "Credencial de integração inválida ou inativa.", { "WWW-Authenticate": "Bearer" });
      return true;
    }
    try {
      const route = resolveRoute(url.pathname, request.method);
      const result = await store.withAuthorization(token, route?.scopes ?? [], async (client, principal) => {
        if ([...url.searchParams].length > 0) return { status: 400, code: "invalid_payload", error: "Este endpoint não aceita parâmetros de consulta." };
        if (!route) return routeNotFound();
        if (route.kind === "status") {
          if (request.method !== "GET") return methodNotAllowed(route.allow);
          return { status: 200, data: {
            ok: true, apiVersion: "v1", partner: principal.partner,
            application: { id: principal.applicationId, slug: principal.application.slug,
              name: principal.application.name, status: principal.application.status,
              requestsPerMinute: principal.application.requestsPerMinute },
            credential: { id: principal.credentialId, expiresAt: principal.credential.expiresAt },
            scopes: principal.scopes,
          } };
        }
        if (route.kind === "tribes") {
          if (request.method !== "POST") return methodNotAllowed(route.allow);
          const tribe = parsePartnerTribe(await readPartnerJson(request), { creating: true });
          const result = await store.createPartnerTribe(client, principal, tribe);
          return { status: result.created ? 201 : 200, data: result };
        }
        if (route.kind === "tribe") {
          if (!(["GET", "PATCH"].includes(request.method))) return methodNotAllowed(route.allow);
          const externalTribeId = externalPathId(route.id, "tribo");
          if (request.method === "GET") {
            const tribe = await store.getPartnerTribe(client, principal, externalTribeId);
            return tribe ? { status: 200, data: { tribe } } : { status: 404, code: "resource_not_found", error: "Recurso não encontrado." };
          }
          const tribe = parsePartnerTribe(await readPartnerJson(request), { externalTribeId });
          return { status: 200, data: { tribe: await store.updatePartnerTribe(client, principal, tribe) } };
        }
        if (route.kind === "organizerGrants") {
          if (request.method !== "GET") return methodNotAllowed(route.allow);
          const externalTribeId = externalPathId(route.id, "tribo");
          return { status: 200, data: await store.listPartnerOrganizerGrants(client, principal, externalTribeId) };
        }
        if (route.kind === "events") {
          if (request.method !== "POST") return methodNotAllowed(route.allow);
          const event = parsePartnerEvent(await readPartnerJson(request), { creating: true });
          const result = await store.createPartnerEvent(client, principal, event);
          return { status: result.created ? 201 : 200, data: result };
        }
        if (route.kind === "eventCancel") {
          if (request.method !== "POST") return methodNotAllowed(route.allow);
          return { status: 200, data: await store.cancelPartnerEvent(client, principal, externalPathId(route.id, "evento")) };
        }
        if (route.kind === "participant") {
          const externalEventId = externalPathId(route.eventId, "evento");
          const externalParticipantId = externalPathId(route.participantId, "participante");
          if (request.method === "POST") {
            const participant = parsePartnerParticipant(await readPartnerJson(request));
            const result = await store.createPartnerEventParticipant(client, principal,
              externalEventId, externalParticipantId, participant.claimToken);
            return { status: result.created ? 201 : 200, data: result };
          }
          if (request.method === "DELETE") {
            return { status: 200, data: await store.cancelPartnerEventParticipant(client, principal,
              externalEventId, externalParticipantId) };
          }
          return methodNotAllowed(route.allow);
        }
        if (route.kind === "participantClaimToken") {
          if (request.method !== "PUT") return methodNotAllowed(route.allow);
          const externalEventId = externalPathId(route.eventId, "evento");
          const externalParticipantId = externalPathId(route.participantId, "participante");
          const participant = parsePartnerParticipant(await readPartnerJson(request));
          return { status: 200, data: await store.rotatePartnerParticipantClaimToken(client, principal,
            externalEventId, externalParticipantId, participant.claimToken) };
        }
        if (route.kind === "event") {
          if (!(["GET", "PATCH"].includes(request.method))) return methodNotAllowed(route.allow);
          const externalEventId = externalPathId(route.id, "evento");
          if (request.method === "GET") {
            const event = await store.getPartnerEvent(client, principal, externalEventId);
            return event ? { status: 200, data: { event } } : { status: 404, code: "resource_not_found", error: "Recurso não encontrado." };
          }
          const event = parsePartnerEvent(await readPartnerJson(request));
          return { status: 200, data: { event: await store.updatePartnerEvent(client, principal, externalEventId, event) } };
        }
        return routeNotFound();
      });
      if (result.error) fail(result.status, result.code, result.error, result.headers);
      else sendJson(response, result.status, result.data);
    } catch (error) {
      if (error instanceof PartnerError) {
        if (error.statusCode === 401) authLimiter.record(ip);
        fail(error.statusCode, error.code, error.message, error.headers);
      } else {
        // Do not log database errors: their detail can contain credential hashes
        // or, in future stages, participant data.
        logError("Falha na API de parceiros", { requestId, code: "partner_api_unavailable" });
        fail(503, "partner_api_unavailable", "API de integração temporariamente indisponível.");
      }
    }
    return true;
  };
}

export const handlePartnerRequest = createPartnerRequestHandler();
