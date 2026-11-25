import "./load-env.mjs";
import { createServer } from "node:http";
import { readJson, sendJson } from "./http-utils.mjs";
import {
  ANALYTICS_CATEGORIES,
  PUBLIC_ANALYTICS_EVENTS,
  checkDatabase,
  deleteOldAnalyticsSessions,
  getProductionMetrics,
  recordAnalyticsEvent,
} from "./analytics-store.mjs";
import { createSessionToken } from "./security.mjs";
import { isMetricsAdmin, parseMetricsAdminEmails } from "./metrics-auth.mjs";
import { handleSocialRequest } from "./social-api.mjs";
import { deleteExpiredTribeMessages, getSessionUser, initializeSocialStore } from "./social-store.mjs";
import { startEmailQueueWorker } from "./email-queue-worker.mjs";

const PORT = Number(process.env.PORT ?? 4000);
const ANALYTICS_COOKIE = "tribes_analytics";
const AUTH_COOKIE = "tribes_session";

const rateMap = new Map();

function readCookie(request, name) {
  for (const cookie of request.headers.cookie?.split(";") ?? []) {
    const separator = cookie.indexOf("=");
    if (separator < 0 || cookie.slice(0, separator).trim() !== name) continue;
    const value = cookie.slice(separator + 1).trim();
    try {
      return decodeURIComponent(value);
    } catch {
      return value;
    }
  }
  return null;
}

function analyticsCookie(token) {
  const secure = process.env.NODE_ENV === "production" ? "; Secure" : "";
  return `${ANALYTICS_COOKIE}=${encodeURIComponent(token)}; HttpOnly; SameSite=Lax; Path=/; Max-Age=86400${secure}`;
}

function checkRateLimit(ip) {
  const now = Date.now();

  if (rateMap.size > 1000) {
    for (const [key, value] of rateMap.entries()) {
      if (now - value.windowStart > 60_000) rateMap.delete(key);
    }
    if (rateMap.size > 1000) return false;
  }

  const existing = rateMap.get(ip);
  if (!existing || now - existing.windowStart > 60_000) {
    rateMap.set(ip, { count: 1, windowStart: now });
    return true;
  }
  if (existing.count >= 120) return false;

  existing.count += 1;
  return true;
}

function isAllowedFrontendOrigin(origin) {
  const configuredOrigins = [
    process.env.FRONTEND_URL,
    ...(process.env.FRONTEND_ORIGINS ?? "").split(","),
  ];
  const allowedOrigins = new Set();
  for (const value of configuredOrigins) {
    if (!value?.trim()) continue;
    try {
      allowedOrigins.add(new URL(value.trim()).origin);
    } catch {
      // Ignore malformed origin configuration; it cannot authorize a request.
    }
  }
  try {
    return allowedOrigins.has(new URL(origin).origin);
  } catch {
    return false;
  }
}

const server = createServer(async (request, response) => {
  response.setHeader("X-Content-Type-Options", "nosniff");
  response.setHeader("Referrer-Policy", "strict-origin-when-cross-origin");
  response.setHeader("X-Frame-Options", "DENY");
  response.setHeader("Permissions-Policy", "camera=(), microphone=(), geolocation=()");
  if (process.env.NODE_ENV === "production") {
    response.setHeader("Strict-Transport-Security", "max-age=31536000; includeSubDomains");
  }
  const pathname = new URL(request.url ?? "/", "http://localhost").pathname;
  const origin = request.headers.origin;
  if (origin && !["GET", "HEAD", "OPTIONS"].includes(request.method ?? "GET") && !isAllowedFrontendOrigin(origin)) {
    return sendJson(response, 403, { error: "Origem da requisição não permitida." });
  }

  if (request.method === "GET" && pathname === "/health") {
    try {
      await checkDatabase();
      return sendJson(response, 200, { ok: true });
    } catch {
      return sendJson(response, 503, { ok: false, error: "Banco indisponível." });
    }
  }

  if (pathname === "/api/analytics/events") {
    if (request.method !== "POST") {
      return sendJson(response, 405, { error: "Método não permitido." }, { Allow: "POST" });
    }
    const forwardedIp = request.headers["x-forwarded-for"]?.split(",")[0]?.trim();
    const clientIp = (forwardedIp ?? request.socket.remoteAddress ?? "local").slice(0, 64);
    if (!checkRateLimit(clientIp)) {
      return sendJson(response, 429, { error: "Muitas requisições em sequência. Tente novamente em instantes." });
    }

    let payload;
    try {
      payload = await readJson(request, { maxSize: 4 * 1024, invalidMessage: "Payload JSON inválido." });
    } catch (error) {
      return sendJson(response, error.statusCode ?? 400, { error: error.message ?? "Payload JSON inválido." });
    }
    if (!PUBLIC_ANALYTICS_EVENTS.has(payload.event)) {
      return sendJson(response, 400, { error: "Tipo de evento não permitido." });
    }
    if (payload.event === "page_view" && !["/", "/explorar", "/cadastro"].includes(payload.pagePath)) {
      return sendJson(response, 400, { error: "Caminho de página não permitido." });
    }
    if (payload.event === "explorer_interaction" && payload.category !== undefined &&
      (typeof payload.category !== "string" || !ANALYTICS_CATEGORIES.has(payload.category))) {
      return sendJson(response, 400, { error: "Categoria não permitida." });
    }

    const existingToken = readCookie(request, ANALYTICS_COOKIE);
    const sessionToken = existingToken && /^[A-Za-z0-9_-]{43}$/.test(existingToken)
      ? existingToken
      : createSessionToken();
    try {
      const activeSessionToken = await recordAnalyticsEvent({
        sessionToken,
        event: payload.event,
        pagePath: typeof payload.pagePath === "string" ? payload.pagePath : "",
        category: typeof payload.category === "string" && ANALYTICS_CATEGORIES.has(payload.category)
          ? payload.category
          : undefined,
      });
      const headers = activeSessionToken !== existingToken
        ? { "Set-Cookie": analyticsCookie(activeSessionToken) }
        : {};
      return sendJson(response, 200, { ok: true }, headers);
    } catch (error) {
      console.error("Falha ao registrar evento analítico:", error);
      return sendJson(response, 503, { error: "Não foi possível registrar o evento." });
    }
  }

  if (pathname === "/api/admin/metrics") {
    if (request.method !== "GET") {
      return sendJson(response, 405, { error: "Método não permitido." }, { Allow: "GET" });
    }
    const allowedEmails = parseMetricsAdminEmails();
    if (allowedEmails.size === 0) {
      return sendJson(response, 503, { error: "Acesso ao painel não configurado." });
    }
    try {
      const user = await getSessionUser(readCookie(request, AUTH_COOKIE));
      if (!user) return sendJson(response, 401, { error: "Autenticação necessária." });
      if (!isMetricsAdmin(user.email, allowedEmails)) {
        return sendJson(response, 403, { error: "Sem permissão para acessar as métricas." });
      }
      const requestedRange = new URL(request.url ?? "/", "http://localhost").searchParams.get("range") ?? "30d";
      return sendJson(response, 200, await getProductionMetrics(requestedRange));
    } catch (error) {
      console.error("Falha ao consultar métricas:", error);
      return sendJson(response, 503, { error: "Não foi possível consultar as métricas." });
    }
  }

  if (pathname === "/api/mvp-metrics") {
    return sendJson(response, 410, { error: "Endpoint substituído." });
  }

  const handled = await handleSocialRequest(
    request,
    response,
    new URL(request.url ?? "/", "http://localhost")
  );
  if (handled) return;
  return sendJson(response, 404, { error: "Rota não encontrada." });
});

Promise.all([checkDatabase(), initializeSocialStore()])
  .then(() => {
    startEmailQueueWorker();
    const cleanupOldAnalytics = async () => {
      try {
        await deleteOldAnalyticsSessions();
      } catch (error) {
        console.error("Falha ao remover sessões analíticas antigas:", error);
      }
    };
    void cleanupOldAnalytics();
    const analyticsCleanupTimer = setInterval(() => void cleanupOldAnalytics(), 24 * 60 * 60 * 1000);
    analyticsCleanupTimer.unref();
    const cleanExpiredTribeMessages = async () => {
      try {
        await deleteExpiredTribeMessages();
      } catch (error) {
        console.error("Falha ao remover mensagens antigas do chat:", error);
      }
    };
    void cleanExpiredTribeMessages();
    const tribeMessageCleanupTimer = setInterval(() => void cleanExpiredTribeMessages(), 5 * 60 * 1000);
    tribeMessageCleanupTimer.unref();
    server.listen(PORT, "0.0.0.0", () => {
      console.log(`Tribes backend listening on port ${PORT}`);
    });
  })
  .catch((error) => {
    console.error("Falha ao inicializar o backend:", error);
    process.exit(1);
  });
