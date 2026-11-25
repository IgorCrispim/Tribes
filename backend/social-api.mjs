import { hashPassword, verifyPassword, createSessionToken, digestSessionToken, passwordPolicyError } from "./security.mjs";
import { readJson, sendJson } from "./http-utils.mjs";
import { MAX_IMAGE_DATA_URL_SIZE, parseImage } from "./images.mjs";
import { getObjectStorage } from "./object-storage.mjs";
import { wakeEmailQueueWorker } from "./email-queue-worker.mjs";
import { registrationMessageForDelivery } from "./registration-message.mjs";
import { recordAnalyticsEvent } from "./analytics-store.mjs";
import { SESSION_IDLE_TTL_SECONDS } from "./session-policy.mjs";
import {
  addComment,
  createDirectMessage,
  createOrGetDirectConversation,
  createTribeMessage,
  deleteTribeMessage,
  listNotifications,
  listDirectConversations,
  listDirectMessages,
  listTribeMembers,
  listTribeMessages,
  listUpcomingEvents,
  toggleSavedContent,
  toggleCommentLike,
  markNotificationRead,
  markAllNotificationsRead,
  completePasswordReset,
  completeRegistration,
  createContent,
  updateContent,
  updateTribeMessage,
  deleteContent,
  createSession,
  createTribe,
  deleteTribe,
  decodeCursor,
  deleteSession,
  enqueueEmail,
  editComment,
  getContentImage,
  getContentItem,
  getDirectConversation,
  getFeed,
  getPublicUserProfile,
  getPublicTribe,
  getSessionUser,
  renewSession,
  getUserByEmail,
  getUserPasswordHash,
  changeUserPassword,
  waitForEmailQueueDelivery,
  getUserProfileImage,
  joinTribe,
  leaveTribe,
  listComments,
  searchTribes,
  searchDirectMessageUsers,
  setEventAttendance,
  setPollVote,
  toggleLike,
  updateUserProfile,
  updateTribe,
} from "./social-store.mjs";

const SESSION_COOKIE = "tribes_session";
const MAX_POST_PAYLOAD_SIZE = MAX_IMAGE_DATA_URL_SIZE;
const MAX_PROFILE_PAYLOAD_SIZE = MAX_POST_PAYLOAD_SIZE;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const authAttempts = new Map();
const apiAttempts = new Map();
const RATE_WINDOW_MS = 60_000;
const dummyPasswordHash = hashPassword("tribes-invalid-account-password");

function readCookie(request, name) {
  const cookies = request.headers.cookie?.split(";") ?? [];
  for (const cookie of cookies) {
    const separator = cookie.indexOf("=");
    if (separator < 0) continue;
    if (cookie.slice(0, separator).trim() === name) {
      return cookie.slice(separator + 1).trim();
    }
  }
  return null;
}

function allowAuthAttempt(request, identifier) {
  const now = Date.now();
  const ip = String(request.socket.remoteAddress ?? "unknown").slice(0, 64);
  const key = ip + ":" + String(identifier ?? "unknown").slice(0, 254);
  if (authAttempts.size > 2000) {
    for (const [key, attempt] of authAttempts) if (now - attempt.startedAt > 60_000) authAttempts.delete(key);
  }
  const attempt = authAttempts.get(key);
  if (!attempt || now - attempt.startedAt > 60_000) {
    authAttempts.set(key, { count: 1, startedAt: now });
    return true;
  }
  attempt.count += 1;
  return attempt.count <= 12;
}

function sessionCookie(token, maxAgeSeconds = SESSION_IDLE_TTL_SECONDS) {
  const secure = process.env.NODE_ENV === "production" ? "; Secure" : "";
  return `${SESSION_COOKIE}=${encodeURIComponent(token)}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${maxAgeSeconds}${secure}`;
}

function clearSessionCookie() {
  const secure = process.env.NODE_ENV === "production" ? "; Secure" : "";
  return `${SESSION_COOKIE}=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0${secure}`;
}

function invalid(message) {
  const error = new Error(message);
  error.statusCode = 400;
  return error;
}

function requiredString(value, field, min, max) {
  if (typeof value !== "string") throw invalid(`Campo ${field} inválido.`);
  const trimmed = value.trim();
  if (trimmed.length < min || trimmed.length > max) {
    throw invalid(`Campo ${field} deve ter entre ${min} e ${max} caracteres.`);
  }
  return trimmed;
}

function eventCoordinates(payload) {
  const hasLat = payload.lat !== undefined && payload.lat !== null && payload.lat !== "";
  const hasLon = payload.lon !== undefined && payload.lon !== null && payload.lon !== "";
  if (hasLat !== hasLon) throw invalid("Informe latitude e longitude juntas.");
  if (!hasLat) return { lat: null, lon: null };

  const lat = payload.lat;
  const lon = payload.lon;
  if (typeof lat !== "number" || !Number.isFinite(lat) || lat < -90 || lat > 90 ||
    typeof lon !== "number" || !Number.isFinite(lon) || lon < -180 || lon > 180) {
    throw invalid("Coordenadas do local inválidas.");
  }
  return { lat, lon };
}

function requireUuid(value, label) {
  if (typeof value !== "string" || !UUID_PATTERN.test(value)) throw invalid(`${label} inválido.`);
  return value;
}

function withUser(user, data = {}) {
  return { ...data, user: { id: user.id, name: user.name, email: user.email } };
}

async function authenticatedUser(request, response) {
  const token = readCookie(request, SESSION_COOKIE);
  const user = await getSessionUser(token);
  if (!user) return null;
  const renewedTtlSeconds = await renewSession(token, SESSION_IDLE_TTL_SECONDS);
  if (renewedTtlSeconds !== null) response.setHeader("Set-Cookie", sessionCookie(token, renewedTtlSeconds));
  return user;
}

function allowApiAttempt(request, user, method) {
  const now = Date.now();
  if (apiAttempts.size > 10_000) {
    for (const [key, attempt] of apiAttempts) {
      if (now - attempt.startedAt > RATE_WINDOW_MS) apiAttempts.delete(key);
    }
  }
  const write = !["GET", "HEAD", "OPTIONS"].includes(method);
  const key = user ? `user:${user.id}:${write ? "write" : "read"}` : `ip:${request.socket.remoteAddress ?? "unknown"}`;
  const writeLimit = process.env.NODE_ENV === "development" ? 100 : 45;
  const limit = user ? (write ? writeLimit : 180) : 30;
  const attempt = apiAttempts.get(key);
  if (!attempt || now - attempt.startedAt > RATE_WINDOW_MS) {
    apiAttempts.set(key, { count: 1, startedAt: now });
    return true;
  }
  attempt.count += 1;
  return attempt.count <= limit;
}


export async function handleSocialRequest(request, response, url) {
  const pathname = url.pathname.replace(/\/+$/, "") || "/";
  const method = request.method ?? "GET";
  const routeKnown = pathname.startsWith("/api/auth/") || pathname === "/api/maps-config" ||
    pathname === "/api/profile" || /^\/api\/users\/[^/]+\/(?:profile|avatar)$/.test(pathname) ||
    pathname === "/api/dm/users" || pathname === "/api/dm/conversations" || /^\/api\/dm\/conversations\/[^/]+(?:\/messages)?$/.test(pathname) ||
    pathname === "/api/feed" || pathname === "/api/saved" || /^\/api\/content\/[^/]+$/.test(pathname) || /^\/api\/content\/[^/]+\/save$/.test(pathname) || pathname === "/api/events" || pathname === "/api/notifications" || /^\/api\/notifications\/[^/]+\/read$/.test(pathname) || pathname === "/api/notifications/read-all" || pathname === "/api/tribes" ||
    /^\/api\/tribes\/[^/]+$/.test(pathname) || /^\/api\/tribes\/[^/]+\/(?:join|membership|posts|events|members|messages)$/.test(pathname) || /^\/api\/tribes\/[^/]+\/messages\/[^/]+$/.test(pathname) ||
    /^\/api\/content\/[^/]+\/image$/.test(pathname) ||
    /^\/api\/content\/[^/]+\/(?:like|comments|attendance|vote)$/.test(pathname) ||
    /^\/api\/comments\/[^/]+(?:\/like)?$/.test(pathname);
  if (!routeKnown) return false;

  try {
    if (pathname === "/api/auth/me" && method === "GET") {
      return sendJson(response, 200, { user: await authenticatedUser(request, response) }), true;
    }

    if (pathname === "/api/auth/register" && method === "POST") {
      const payload = await readJson(request);
      const email = requiredString(payload.email, "e-mail", 3, 254).toLowerCase();
      if (!allowAuthAttempt(request, email)) {
        sendJson(response, 429, { error: "Muitas tentativas. Aguarde um minuto e tente novamente." }, { "Retry-After": "60" });
        return true;
      }
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw invalid("Informe um e-mail válido.");
      const existingUser = await getUserByEmail(email);
      let message;
      if (!existingUser) {
        const queuedEmail = await enqueueEmail({ email, kind: "registration" });
        wakeEmailQueueWorker();
        const delivery = await waitForEmailQueueDelivery(queuedEmail.id);
        message = registrationMessageForDelivery(delivery);
      } else {
        message = registrationMessageForDelivery(null);
      }
      return sendJson(response, 202, { message }), true;
    }

    if (pathname === "/api/auth/register/complete" && method === "POST") {
      const payload = await readJson(request);
      const token = requiredString(payload.token, "token", 20, 200);
      if (!allowAuthAttempt(request, digestSessionToken(token))) {
        sendJson(response, 429, { error: "Muitas tentativas. Aguarde um minuto e tente novamente." }, { "Retry-After": "60" });
        return true;
      }
      const name = requiredString(payload.name, "nome", 2, 80);
      const passwordError = passwordPolicyError(payload.password);
      if (passwordError) throw invalid(passwordError);
      const sessionToken = createSessionToken();
      let user;
      try {
        user = await completeRegistration({
          tokenHash: digestSessionToken(token),
          displayName: name,
          passwordHash: await hashPassword(payload.password),
          sessionToken,
          sessionExpiresAt: new Date(Date.now() + SESSION_IDLE_TTL_SECONDS * 1000),
        });
      } catch (error) {
        if (error.code === "23505") {
          const conflict = new Error("Este e-mail já possui uma conta. Entre pela tela de login.");
          conflict.statusCode = 409;
          throw conflict;
        }
        throw error;
      }
      if (!user) throw invalid("Este link é inválido, expirou ou já foi usado. Solicite um novo link.");
      const analyticsToken = readCookie(request, "tribes_analytics");
      if (analyticsToken) {
        try {
          await recordAnalyticsEvent({
            sessionToken: analyticsToken,
            event: "registration_complete",
            userId: user.id,
          });
        } catch (error) {
          console.error("Falha ao registrar conclusão de cadastro nas métricas:", error);
        }
      }
      return sendJson(response, 201, withUser(user), { "Set-Cookie": sessionCookie(sessionToken) }), true;
    }

    if (pathname === "/api/auth/password-reset" && method === "POST") {
      const payload = await readJson(request);
      const email = requiredString(payload.email, "e-mail", 3, 254).toLowerCase();
      if (!allowAuthAttempt(request, email)) {
        sendJson(response, 429, { error: "Muitas tentativas. Aguarde um minuto e tente novamente." }, { "Retry-After": "60" });
        return true;
      }
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw invalid("Informe um e-mail válido.");
      const existingUser = await getUserByEmail(email);
      if (existingUser) {
        await enqueueEmail({ email, kind: "password_reset" });
        wakeEmailQueueWorker();
      }
      return sendJson(response, 202, {
        message: "Se este e-mail estiver cadastrado, enviaremos um link assim que houver disponibilidade de envio.",
      }), true;
    }

    if (pathname === "/api/auth/password-reset/complete" && method === "POST") {
      const payload = await readJson(request);
      const token = requiredString(payload.token, "token", 20, 200);
      if (!allowAuthAttempt(request, digestSessionToken(token))) {
        sendJson(response, 429, { error: "Muitas tentativas. Aguarde um minuto e tente novamente." }, { "Retry-After": "60" });
        return true;
      }
      const passwordError = passwordPolicyError(payload.password);
      if (passwordError) throw invalid(passwordError);
      const sessionToken = createSessionToken();
      const user = await completePasswordReset({
        tokenHash: digestSessionToken(token),
        passwordHash: await hashPassword(payload.password),
        sessionToken,
        sessionExpiresAt: new Date(Date.now() + SESSION_IDLE_TTL_SECONDS * 1000),
      });
      if (!user) throw invalid("Este link é inválido, expirou ou já foi usado. Solicite um novo link.");
      return sendJson(response, 200, withUser(user), { "Set-Cookie": sessionCookie(sessionToken) }), true;
    }

    if (pathname === "/api/auth/login" && method === "POST") {
      const payload = await readJson(request);
      const email = requiredString(payload.email, "e-mail", 3, 254).toLowerCase();
      if (!allowAuthAttempt(request, email)) {
        sendJson(response, 429, { error: "Muitas tentativas. Aguarde um minuto e tente novamente." }, { "Retry-After": "60" });
        return true;
      }
      if (typeof payload.password !== "string" || payload.password.length > 128) throw invalid("Credenciais inválidas.");
      const stored = await getUserByEmail(email);
      const validPassword = await verifyPassword(payload.password, stored?.password_hash ?? await dummyPasswordHash);
      if (!stored || !validPassword) {
        const error = new Error("E-mail ou senha incorretos.");
        error.statusCode = 401;
        throw error;
      }
      const user = { id: stored.id, name: stored.display_name, email: stored.email };
      const token = createSessionToken();
      await createSession(user.id, token, new Date(Date.now() + SESSION_IDLE_TTL_SECONDS * 1000));
      return sendJson(response, 200, withUser(user), { "Set-Cookie": sessionCookie(token) }), true;
    }

    if (pathname === "/api/auth/logout" && method === "POST") {
      await deleteSession(readCookie(request, SESSION_COOKIE));
      return sendJson(response, 200, { ok: true }, { "Set-Cookie": clearSessionCookie() }), true;
    }

    const publicTribeMatch = pathname.match(/^\/api\/tribes\/([^/]+)$/);
    if (publicTribeMatch && method === "GET") {
      const tribeId = requireUuid(publicTribeMatch[1], "Tribo");
      const tribe = await getPublicTribe(tribeId);
      if (!tribe) {
        sendJson(response, 404, { error: "Tribo não encontrada." });
        return true;
      }
      sendJson(response, 200, { tribe });
      return true;
    }
    if (pathname === "/api/maps-config" && method === "GET") {
      sendJson(response, 200, { apiKey: process.env.MAPS_API ?? "" }, { "Cache-Control": "no-store, max-age=0" });
      return true;
    }

    const user = await authenticatedUser(request, response);
    if (!user) {
      sendJson(response, 401, { error: "Autenticação necessária." });
      return true;
    }
    const isPasswordChangeRoute = pathname === "/api/auth/password-change" && method === "POST";
    const allowedAttempt = isPasswordChangeRoute
      ? allowAuthAttempt(request, `password-change:${user.id}`)
      : allowApiAttempt(request, user, method);
    if (!allowedAttempt) {
      sendJson(response, 429, { error: "Muitas requisições. Aguarde um minuto e tente novamente." }, { "Retry-After": "60" });
      return true;
    }

    if (isPasswordChangeRoute) {
      const payload = await readJson(request, { requireObject: true, invalidMessage: "Objeto JSON inválido." });
      if (typeof payload.currentPassword !== "string" || payload.currentPassword.length < 1 || payload.currentPassword.length > 128) {
        throw invalid("Informe sua senha atual.");
      }
      if (typeof payload.confirmPassword !== "string" || payload.confirmPassword !== payload.newPassword) {
        throw invalid("A confirmação não corresponde à nova senha.");
      }
      const passwordError = passwordPolicyError(payload.newPassword);
      if (passwordError) throw invalid(passwordError);

      const currentPasswordHash = await getUserPasswordHash(user.id);
      if (!currentPasswordHash || !(await verifyPassword(payload.currentPassword, currentPasswordHash))) {
        const error = new Error("A senha atual está incorreta.");
        error.statusCode = 401;
        throw error;
      }
      if (payload.currentPassword === payload.newPassword) {
        throw invalid("A nova senha deve ser diferente da senha atual.");
      }

      const updated = await changeUserPassword(
        user.id,
        currentPasswordHash,
        await hashPassword(payload.newPassword),
        readCookie(request, SESSION_COOKIE),
      );
      if (!updated) {
        const error = new Error("A senha foi alterada recentemente. Atualize a página e tente novamente.");
        error.statusCode = 409;
        throw error;
      }
      return sendJson(response, 200, { ok: true, message: "Senha alterada. As outras sessões foram encerradas." }), true;
    }

    if (pathname === "/api/profile" && method === "PATCH") {
      const payload = await readJson(request, {
        maxSize: MAX_PROFILE_PAYLOAD_SIZE,
        requireObject: true,
        invalidMessage: "Objeto JSON inválido.",
      });
      const name = requiredString(payload.name, "nome", 2, 80);
      if (typeof payload.aboutMe !== "string" || payload.aboutMe.trim().length > 500) {
        throw invalid("O campo sobre mim deve ter até 500 caracteres.");
      }
      const aboutMe = payload.aboutMe.trim();
      const city = typeof payload.city === "string" ? payload.city.trim() : "";
      if (city.length > 100) throw invalid("A cidade deve ter até 100 caracteres.");
      if (!Array.isArray(payload.interests) || payload.interests.length > 20 ||
        payload.interests.some((interest) => typeof interest !== "string" || interest.trim().length < 1 || interest.trim().length > 30)) {
        throw invalid("Informe até 20 interesses, com no máximo 30 caracteres cada.");
      }
      const interests = [...new Set(payload.interests.map((interest) => interest.trim()))];
      const visibilityFields = ["aboutMe", "city", "interests"];
      let profileVisibility;
      if (Object.hasOwn(payload, "profileVisibility")) {
        if (!payload.profileVisibility || typeof payload.profileVisibility !== "object" ||
          visibilityFields.some((field) => !["public", "private"].includes(payload.profileVisibility[field]))) {
          throw invalid("As configurações de privacidade são inválidas.");
        }
        profileVisibility = Object.fromEntries(visibilityFields.map((field) => [field, payload.profileVisibility[field]]));
      }
      const avatar = Object.hasOwn(payload, "avatar")
        ? payload.avatar === null ? null : await parseImage(payload.avatar)
        : undefined;
      const updatedUser = await updateUserProfile(user.id, { name, aboutMe, city, interests, profileVisibility, avatar });
      if (!updatedUser) {
        sendJson(response, 404, { error: "Usuário não encontrado." });
        return true;
      }
      sendJson(response, 200, { user: updatedUser });
      return true;
    }

    const publicProfileMatch = pathname.match(/^\/api\/users\/([^/]+)\/profile$/);
    if (publicProfileMatch && method === "GET") {
      const profile = await getPublicUserProfile(requireUuid(publicProfileMatch[1], "Usuário"), user.id);
      if (!profile) {
        sendJson(response, 404, { error: "Perfil não encontrado." });
        return true;
      }
      sendJson(response, 200, { profile });
      return true;
    }


    const profileAvatarMatch = pathname.match(/^\/api\/users\/([^/]+)\/avatar$/);
    if (profileAvatarMatch && method === "GET") {
      const avatar = await getUserProfileImage(requireUuid(profileAvatarMatch[1], "Usuário"));
      if (!avatar) {
        sendJson(response, 404, { error: "Foto de perfil não encontrada." });
        return true;
      }
      if (avatar.imageKey) {
        const location = await getObjectStorage().createReadUrl(avatar.imageKey, avatar.mimeType);
        response.writeHead(302, { Location: location, "Cache-Control": "private, no-store" });
        response.end();
        return true;
      }
      response.writeHead(200, {
        "Content-Type": avatar.mimeType,
        "Content-Length": avatar.data.length,
        "Cache-Control": "private, no-store",
        "X-Content-Type-Options": "nosniff",
      });
      response.end(avatar.data);
      return true;
    }

    if (pathname === "/api/dm/users" && method === "GET") {
      const query = (url.searchParams.get("q") ?? "").trim();
      if (query.length > 100) throw invalid("A busca deve ter até 100 caracteres.");
      sendJson(response, 200, { users: query.length < 2 ? [] : await searchDirectMessageUsers(user.id, query, 20) });
      return true;
    }

    if (pathname === "/api/dm/conversations" && method === "GET") {
      sendJson(response, 200, { conversations: await listDirectConversations(user.id) });
      return true;
    }

    if (pathname === "/api/dm/conversations" && method === "POST") {
      const payload = await readJson(request, { requireObject: true, invalidMessage: "Objeto JSON inválido." });
      const recipientId = requireUuid(payload.recipientId, "Destinatário");
      if (recipientId === user.id) {
        sendJson(response, 400, { error: "Escolha outra pessoa para iniciar a conversa." });
        return true;
      }
      const conversation = await createOrGetDirectConversation(user.id, recipientId);
      if (!conversation) {
        sendJson(response, 404, { error: "Usuário não encontrado." });
        return true;
      }
      sendJson(response, 201, { conversation });
      return true;
    }

    const directConversationMatch = pathname.match(/^\/api\/dm\/conversations\/([^/]+)$/);
    if (directConversationMatch && method === "GET") {
      const conversation = await getDirectConversation(user.id, requireUuid(directConversationMatch[1], "Conversa"));
      if (!conversation) {
        sendJson(response, 404, { error: "Conversa não encontrada." });
        return true;
      }
      sendJson(response, 200, { conversation });
      return true;
    }

    const directMessagesMatch = pathname.match(/^\/api\/dm\/conversations\/([^/]+)\/messages$/);
    if (directMessagesMatch && ["GET", "POST"].includes(method)) {
      const conversationId = requireUuid(directMessagesMatch[1], "Conversa");
      if (method === "GET") {
        const messages = await listDirectMessages(user.id, conversationId);
        if (!messages) {
          sendJson(response, 404, { error: "Conversa não encontrada." });
          return true;
        }
        sendJson(response, 200, { messages });
        return true;
      }
      const payload = await readJson(request, { requireObject: true, invalidMessage: "Objeto JSON inválido." });
      const body = requiredString(payload.body, "mensagem", 1, 1000);
      const message = await createDirectMessage(user.id, conversationId, body);
      if (!message) {
        sendJson(response, 404, { error: "Conversa não encontrada." });
        return true;
      }
      sendJson(response, 201, { message });
      return true;
    }

    const contentImageMatch = pathname.match(/^\/api\/content\/([^/]+)\/image$/);
    if (contentImageMatch && method === "GET") {
      const contentId = requireUuid(contentImageMatch[1], "Conteúdo");
      const image = await getContentImage(user.id, contentId);
      if (!image) {
        sendJson(response, 404, { error: "Imagem não encontrada ou sem acesso." });
        return true;
      }
      if (image.imageKey) {
        const location = await getObjectStorage().createReadUrl(image.imageKey, image.mimeType);
        response.writeHead(302, { Location: location, "Cache-Control": "private, no-store" });
        response.end();
        return true;
      }
      response.writeHead(200, {
        "Content-Type": image.mimeType,
        "Content-Length": image.data.length,
        "Cache-Control": "private, no-store",
        "X-Content-Type-Options": "nosniff",
      });
      response.end(image.data);
      return true;
    }

    if (pathname === "/api/notifications" && method === "GET") {
      sendJson(response, 200, await listNotifications(user.id));
      return true;
    }

    if (pathname === "/api/notifications/read-all" && method === "POST") {
      const updated = await markAllNotificationsRead(user.id);
      sendJson(response, 200, { updated, unreadCount: 0 });
      return true;
    }

    const notificationReadMatch = pathname.match(/^\/api\/notifications\/([^/]+)\/read$/);
    if (notificationReadMatch && method === "POST") {
      const notificationId = requireUuid(notificationReadMatch[1], "Notificação");
      const updated = await markNotificationRead(user.id, notificationId);
      if (!updated) {
        sendJson(response, 404, { error: "Notificação não encontrada." });
        return true;
      }
      sendJson(response, 200, { ok: true });
      return true;
    }

    if ((pathname === "/api/feed" || pathname === "/api/saved") && method === "GET") {
      const rawLimit = url.searchParams.get("limit");
      const limit = rawLimit === null ? 20 : Number(rawLimit);
      if (!Number.isInteger(limit) || limit < 1 || limit > 50) throw invalid("Limite de página inválido (1–50).");
      const query = (url.searchParams.get("q") ?? "").trim();
      if (query.length > 100) throw invalid("A busca deve ter até 100 caracteres.");
      const tribeId = url.searchParams.get("tribeId") || undefined;
      if (tribeId) requireUuid(tribeId, "Tribo");
      const type = url.searchParams.get("type") ?? "all";
      if (!["all", "post", "event", "poll"].includes(type)) throw invalid("Tipo de conteúdo inválido.");
      const result = await getFeed(user.id, {
        tribeId,
        query,
        type,
        cursor: decodeCursor(url.searchParams.get("cursor")),
        limit,
        savedOnly: pathname === "/api/saved",
      });
      sendJson(response, 200, result);
      return true;
    }

    if (pathname === "/api/events" && method === "GET") {
      const query = (url.searchParams.get("q") ?? "").trim();
      if (query.length > 100) throw invalid("A busca deve ter até 100 caracteres.");
      const tribeId = url.searchParams.get("tribeId") || undefined;
      if (tribeId) requireUuid(tribeId, "Tribo");
      const from = url.searchParams.get("from");
      const to = url.searchParams.get("to");
      const attending = url.searchParams.get("attending");
      if (from !== null || to !== null || attending !== null) {
        const validUtcTimestamp = (value) => {
          if (!value || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)) return false;
          const date = new Date(value);
          return Number.isFinite(date.getTime()) && date.toISOString() === value;
        };
        if (!validUtcTimestamp(from) || !validUtcTimestamp(to) || Date.parse(to) <= Date.parse(from) || attending !== "true") {
          throw invalid("Informe um intervalo válido e solicite apenas eventos com presença confirmada.");
        }
        sendJson(response, 200, {
          events: await listUpcomingEvents(user.id, null, {
            from,
            to,
            tribeId,
            attendingOnly: true,
          }),
        });
        return true;
      }
      sendJson(response, 200, { events: await listUpcomingEvents(user.id, 100, { query, tribeId }) });
      return true;
    }

    const membersMatch = pathname.match(/^\/api\/tribes\/([^/]+)\/members$/);
    if (membersMatch && method === "GET") {
      const members = await listTribeMembers(user.id, requireUuid(membersMatch[1], "Tribo"));
      if (!members) {
        sendJson(response, 404, { error: "Tribo não encontrada ou você não participa dela." });
        return true;
      }
      sendJson(response, 200, { members });
      return true;
    }

    const tribeMessagesMatch = pathname.match(/^\/api\/tribes\/([^/]+)\/messages$/);
    if (tribeMessagesMatch && ["GET", "POST"].includes(method)) {
      const tribeId = requireUuid(tribeMessagesMatch[1], "Tribo");
      if (method === "GET") {
        const messages = await listTribeMessages(user.id, tribeId);
        if (!messages) {
          sendJson(response, 404, { error: "Tribo não encontrada ou você não participa dela." });
          return true;
        }
        sendJson(response, 200, { messages });
        return true;
      }
      const payload = await readJson(request, { requireObject: true, invalidMessage: "Objeto JSON inválido." });
      const body = requiredString(payload.body, "mensagem", 1, 1000);
      const message = await createTribeMessage(user.id, tribeId, body);
      if (!message) {
        sendJson(response, 404, { error: "Tribo não encontrada ou você não participa dela." });
        return true;
      }
      sendJson(response, 201, { message });
      return true;
    }

    const tribeMessageMatch = pathname.match(/^\/api\/tribes\/([^/]+)\/messages\/([^/]+)$/);
    if (tribeMessageMatch && ["PATCH", "DELETE"].includes(method)) {
      const tribeId = requireUuid(tribeMessageMatch[1], "Tribo");
      const messageId = requireUuid(tribeMessageMatch[2], "Mensagem");
      if (method === "PATCH") {
        const payload = await readJson(request, { requireObject: true, invalidMessage: "Objeto JSON inválido." });
        const body = requiredString(payload.body, "mensagem", 1, 1000);
        const message = await updateTribeMessage(user.id, tribeId, messageId, body);
        if (!message) {
          sendJson(response, 404, { error: "Mensagem não encontrada ou sem permissão." });
          return true;
        }
        sendJson(response, 200, { message: { id: message.id, body: message.body, editedAt: message.edited_at } });
        return true;
      }
      const deleted = await deleteTribeMessage(user.id, tribeId, messageId);
      if (!deleted) {
        sendJson(response, 404, { error: "Mensagem não encontrada ou sem permissão." });
        return true;
      }
      sendJson(response, 200, { ok: true });
      return true;
    }

    const saveMatch = pathname.match(/^\/api\/content\/([^/]+)\/save$/);
    if (saveMatch && ["POST", "DELETE"].includes(method)) {
      const result = await toggleSavedContent(user.id, requireUuid(saveMatch[1], "Publicação"), method === "POST");
      if (!result) {
        sendJson(response, 404, { error: "Publicação não encontrada ou sem acesso." });
        return true;
      }
      sendJson(response, 200, result);
      return true;
    }

    if (pathname === "/api/tribes" && method === "GET") {
      const query = (url.searchParams.get("q") ?? "").trim();
      if (query.length > 100) throw invalid("A busca deve ter até 100 caracteres.");
      const mine = url.searchParams.get("mine") === "true";
      const managed = url.searchParams.get("managed") === "true";
      const tribes = await searchTribes(user.id, { query, mine, managed, limit: 50 });
      sendJson(response, 200, { tribes });
      return true;
    }

    const tribeMatch = pathname.match(/^\/api\/tribes\/([^/]+)$/);
    if (tribeMatch && method === "DELETE") {
      const tribeId = requireUuid(tribeMatch[1], "Tribo");
      const payload = await readJson(request, { requireObject: true, invalidMessage: "Objeto JSON inválido." });
      const confirmationName = requiredString(payload.confirmationName, "nome de confirmação", 2, 80);
      const deleted = await deleteTribe(user.id, tribeId, confirmationName);
      if (deleted === null) {
        sendJson(response, 404, { error: "Tribo não encontrada ou você não tem permissão para excluí-la." });
        return true;
      }
      if (!deleted) {
        sendJson(response, 400, { error: "O nome informado não corresponde ao nome atual da tribo." });
        return true;
      }
      sendJson(response, 200, { ok: true });
      return true;
    }
    if (tribeMatch && ["PATCH", "PUT"].includes(method)) {
      const tribeId = requireUuid(tribeMatch[1], "Tribo");
      const payload = await readJson(request, { requireObject: true, invalidMessage: "Objeto JSON inválido." });
      const format = payload.format;
      if (!["Presencial", "Híbrido", "Online"].includes(format)) throw invalid("Formato de tribo inválido.");
      const tribe = await updateTribe(user.id, tribeId, {
        name: requiredString(payload.name, "nome", 2, 80),
        description: requiredString(payload.description, "descrição", 2, 1000),
        category: requiredString(payload.category, "categoria", 2, 60),
        format,
        city: requiredString(payload.city, "cidade", 2, 100),
        neighborhood: typeof payload.neighborhood === "string" ? payload.neighborhood.trim().slice(0, 100) : "",
      });
      if (!tribe) {
        sendJson(response, 404, { error: "Tribo não encontrada ou você não tem permissão para editá-la." });
        return true;
      }
      sendJson(response, 200, { tribe });
      return true;
    }

    if (pathname === "/api/tribes" && method === "POST") {
      const payload = await readJson(request);
      const format = payload.format;
      if (!["Presencial", "Híbrido", "Online"].includes(format)) throw invalid("Formato de tribo inválido.");
      const tribe = await createTribe(user.id, {
        name: requiredString(payload.name, "nome", 2, 80),
        description: requiredString(payload.description, "descrição", 2, 1000),
        category: requiredString(payload.category, "categoria", 2, 60),
        format,
        city: requiredString(payload.city, "cidade", 2, 100),
        neighborhood: typeof payload.neighborhood === "string" ? payload.neighborhood.trim().slice(0, 100) : "",
      });
      sendJson(response, 201, { tribe });
      return true;
    }

    const membershipMatch = pathname.match(/^\/api\/tribes\/([^/]+)\/(join|membership)$/);
    if (membershipMatch && ["POST", "DELETE"].includes(method)) {
      const tribeId = requireUuid(membershipMatch[1], "Tribo");
      const joined = method === "POST";
      const result = joined ? await joinTribe(user.id, tribeId) : await leaveTribe(user.id, tribeId);
      const success = joined ? result : true;
      if (!success && joined) {
        const error = new Error("Tribo não encontrada.");
        error.statusCode = 404;
        throw error;
      }
      sendJson(response, 200, joined
        ? { isMember: true }
        : { isMember: false, tribeDeleted: result.tribeDeleted });
      return true;
    }

    const contentMatch = pathname.match(/^\/api\/tribes\/([^/]+)\/(posts|events)$/);
    if (contentMatch && method === "POST") {
      const tribeId = requireUuid(contentMatch[1], "Tribo");
      const type = contentMatch[2] === "posts" ? "post" : "event";
      const payload = await readJson(request, {
        maxSize: MAX_POST_PAYLOAD_SIZE,
        requireObject: true,
        invalidMessage: "Objeto JSON inválido.",
      });
      const body = requiredString(payload.body, "texto", 1, 5000);
      const image = await parseImage(payload.image);
      let pollOptions;
      let pollMultiple = false;
      if (type === "post" && payload.pollOptions !== undefined) {
        if (payload.pollMultiple !== undefined && typeof payload.pollMultiple !== "boolean") {
          throw invalid("Configuração de múltiplas respostas inválida.");
        }
        pollMultiple = payload.pollMultiple === true;
        if (!Array.isArray(payload.pollOptions) || payload.pollOptions.length < 2 || payload.pollOptions.length > 6) {
          throw invalid("Uma enquete deve ter de 2 a 6 opções.");
        }
        pollOptions = payload.pollOptions.map((option) => requiredString(option, "opção", 1, 80));
        if (new Set(pollOptions.map((option) => option.toLocaleLowerCase("pt-BR"))).size !== pollOptions.length) {
          throw invalid("As opções da enquete não podem se repetir.");
        }
      }
      let event;
      if (type === "event") {
        const startsAt = requiredString(payload.startsAt, "data do evento", 10, 40);
        if (!Number.isFinite(Date.parse(startsAt))) throw invalid("Data do evento inválida.");
        const endsAt = payload.endsAt ? requiredString(payload.endsAt, "fim do evento", 10, 40) : null;
        if (endsAt && (!Number.isFinite(Date.parse(endsAt)) || Date.parse(endsAt) <= Date.parse(startsAt))) {
          throw invalid("A data de término deve ser posterior ao início.");
        }
        const maxAttendees = payload.maxAttendees === "" || payload.maxAttendees == null
          ? null : Number(payload.maxAttendees);
        if (maxAttendees !== null && (!Number.isInteger(maxAttendees) || maxAttendees < 1 || maxAttendees > 10000)) {
          throw invalid("Limite de participantes inválido.");
        }
        event = {
          title: requiredString(payload.title, "título do evento", 2, 120),
          startsAt,
          endsAt,
          location: requiredString(payload.location, "local", 2, 240),
          ...eventCoordinates(payload),
          cost: typeof payload.cost === "string" ? payload.cost.trim().slice(0, 100) : "",
          maxAttendees,
        };
      }
      const item = await createContent(user.id, tribeId, { type: pollOptions ? "poll" : type, body, event, image, pollOptions, pollMultiple });
      sendJson(response, 201, { id: item.id, createdAt: item.created_at });
      return true;
    }

    const contentItemMatch = pathname.match(/^\/api\/content\/([^/]+)$/);
    if (contentItemMatch && method === "GET") {
      const contentId = requireUuid(contentItemMatch[1], "Publicação");
      const item = await getContentItem(user.id, contentId);
      if (!item) {
        sendJson(response, 404, { error: "Publicação não encontrada ou sem acesso." });
        return true;
      }
      sendJson(response, 200, { item });
      return true;
    }
    if (contentItemMatch && ["PATCH", "DELETE"].includes(method)) {
      const contentId = requireUuid(contentItemMatch[1], "Publicação");
      if (method === "PATCH") {
        const payload = await readJson(request, { requireObject: true, invalidMessage: "Objeto JSON inválido." });
        let event;
        if (payload.event !== undefined) {
          if (!payload.event || typeof payload.event !== "object" || Array.isArray(payload.event)) throw invalid("Dados do evento inválidos.");
          const startsAt = requiredString(payload.event.startsAt, "data do evento", 10, 40);
          if (!Number.isFinite(Date.parse(startsAt))) throw invalid("Data do evento inválida.");
          const endsAt = payload.event.endsAt ? requiredString(payload.event.endsAt, "fim do evento", 10, 40) : null;
          if (endsAt && (!Number.isFinite(Date.parse(endsAt)) || Date.parse(endsAt) <= Date.parse(startsAt))) {
            throw invalid("A data de término deve ser posterior ao início.");
          }
          const maxAttendees = payload.event.maxAttendees === "" || payload.event.maxAttendees == null
            ? null : Number(payload.event.maxAttendees);
          if (maxAttendees !== null && (!Number.isInteger(maxAttendees) || maxAttendees < 1 || maxAttendees > 10000)) {
            throw invalid("Limite de participantes inválido.");
          }
          event = {
            title: requiredString(payload.event.title, "título do evento", 2, 120),
            startsAt,
            endsAt,
            location: requiredString(payload.event.location, "local", 2, 240),
            ...eventCoordinates(payload.event),
            cost: typeof payload.event.cost === "string" ? payload.event.cost.trim().slice(0, 100) : "",
            maxAttendees,
          };
        }
        const item = await updateContent(user.id, contentId, requiredString(payload.body, "texto", 1, 5000), event);
        if (!item) {
          sendJson(response, 404, { error: "Publicação não encontrada ou sem permissão." });
          return true;
        }
        sendJson(response, 200, { item: { id: item.id, body: item.body, editedAt: item.edited_at } });
        return true;
      }
      const deleted = await deleteContent(user.id, contentId);
      if (!deleted) {
        sendJson(response, 404, { error: "Publicação não encontrada ou sem permissão." });
        return true;
      }
      sendJson(response, 200, { ok: true });
      return true;
    }

    const likeMatch = pathname.match(/^\/api\/content\/([^/]+)\/like$/);
    if (likeMatch && ["POST", "DELETE"].includes(method)) {
      const contentId = requireUuid(likeMatch[1], "Conteúdo");
      const result = await toggleLike(user.id, contentId, method === "POST");
      if (!result) {
        sendJson(response, 404, { error: "Conteúdo não encontrado ou sem acesso." });
        return true;
      }
      sendJson(response, 200, result);
      return true;
    }

    const voteMatch = pathname.match(/^\/api\/content\/([^/]+)\/vote$/);
    if (voteMatch && method === "POST") {
      const contentId = requireUuid(voteMatch[1], "Enquete");
      const payload = await readJson(request, { requireObject: true, invalidMessage: "Objeto JSON inválido." });
      const optionId = requireUuid(payload.optionId, "Opção");
      const result = await setPollVote(user.id, contentId, optionId);
      if (!result) {
        sendJson(response, 404, { error: "Enquete não encontrada ou sem acesso." });
        return true;
      }
      if (result.invalidOption) throw invalid("Essa opção não pertence à enquete.");
      sendJson(response, 200, result);
      return true;
    }

    const attendanceMatch = pathname.match(/^\/api\/content\/([^/]+)\/attendance$/);
    if (attendanceMatch && ["POST", "DELETE"].includes(method)) {
      const contentId = requireUuid(attendanceMatch[1], "Evento");
      const result = await setEventAttendance(user.id, contentId, method === "POST");
      if (!result) {
        sendJson(response, 404, { error: "Evento não encontrado ou sem acesso." });
        return true;
      }
      sendJson(response, 200, result);
      return true;
    }

    const commentsMatch = pathname.match(/^\/api\/content\/([^/]+)\/comments$/);
    if (commentsMatch && ["GET", "POST"].includes(method)) {
      const contentId = requireUuid(commentsMatch[1], "Conteúdo");
      if (method === "GET") {
        const comments = await listComments(user.id, contentId);
        if (!comments) {
          sendJson(response, 404, { error: "Conteúdo não encontrado ou sem acesso." });
          return true;
        }
        sendJson(response, 200, { comments });
        return true;
      }
      const payload = await readJson(request);
      const body = requiredString(payload.body, "comentário", 1, 2000);
      const comment = await addComment(user.id, contentId, body);
      if (!comment) {
        sendJson(response, 404, { error: "Conteúdo não encontrado ou sem acesso." });
        return true;
      }
      const comments = await listComments(user.id, contentId);
      sendJson(response, 201, { comment: comments.find((entry) => entry.id === comment.id) });
      return true;
    }

    const commentLikeMatch = pathname.match(/^\/api\/comments\/([^/]+)\/like$/);
    if (commentLikeMatch && ["POST", "DELETE"].includes(method)) {
      const commentId = requireUuid(commentLikeMatch[1], "Comentário");
      const result = await toggleCommentLike(user.id, commentId, method === "POST");
      if (!result) {
        sendJson(response, 404, { error: "Comentário não encontrado ou sem acesso." });
        return true;
      }
      sendJson(response, 200, result);
      return true;
    }

    const commentMatch = pathname.match(/^\/api\/comments\/([^/]+)$/);
    if (commentMatch && ["PATCH", "DELETE"].includes(method)) {
      const commentId = requireUuid(commentMatch[1], "Comentário");
      const body = method === "PATCH" ? requiredString((await readJson(request)).body, "comentário", 1, 2000) : undefined;
      const comment = await editComment(user.id, commentId, body, method === "DELETE");
      if (!comment) {
        sendJson(response, 404, { error: "Comentário não encontrado ou sem permissão." });
        return true;
      }
      sendJson(response, 200, {
        ok: true,
        comment: {
          id: comment.id,
          body: comment.body,
          createdAt: comment.created_at,
          editedAt: comment.edited_at,
        },
      });
      return true;
    }

    if (method !== "GET" && method !== "POST" && method !== "PATCH" && method !== "DELETE") {
      sendJson(response, 405, { error: "Método não permitido." });
      return true;
    }
    sendJson(response, 404, { error: "Rota não encontrada." });
    return true;
  } catch (error) {
    if ((error.statusCode ?? 500) >= 500) {
      console.error("Falha na API social:", error);
    }
    sendJson(response, error.statusCode ?? 500, {
      error: error.statusCode ? error.message : "Não foi possível concluir a operação.",
    });
    return true;
  }
}
