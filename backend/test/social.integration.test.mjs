import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import https from "node:https";
import pg from "pg";
import { digestSessionToken } from "../security.mjs";
import { createObjectStorage, getObjectStorage } from "../object-storage.mjs";
import { transferLegacyImageRow } from "../legacy-image-migration.mjs";

const { Pool } = pg;
const origin = process.env.TRIBES_TEST_ORIGIN;
const mailhogApi = process.env.MAILHOG_API_URL;
const integrationTest = origin && mailhogApi && process.env.R2_ENDPOINT && process.env.R2_BUCKET_NAME ? test : test.skip;

function decodeMailhogBodies(parts) {
  return parts.map((part) => {
    const body = part.Body ?? "";
    const transferEncoding = part.Headers?.["Content-Transfer-Encoding"]?.[0]?.toLowerCase();
    if (transferEncoding === "base64") {
      return Buffer.from(body.replace(/\s/g, ""), "base64").toString("utf8");
    }
    return body
      .replace(/=\r?\n/g, "")
      .replace(/=([0-9a-f]{2})/gi, (_, byte) => String.fromCharCode(Number.parseInt(byte, 16)));
  }).join("\n");
}

integrationTest("authenticated social feed, event attendance, likes, comments and cursor pagination", async (t) => {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  const marker = `test-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const userIds = [];
  const tribeIds = [];

  async function call(actor, path, options = {}) {
    const response = await fetch(`${origin}${path}`, {
      ...options,
      headers: {
        ...(options.body ? { "Content-Type": "application/json" } : {}),
        ...(actor ? { Cookie: actor.cookie } : {}),
        ...options.headers,
      },
    });
    const data = await response.json();
    return { response, data };
  }

  async function register(label) {
    const email = `${marker}-${label}@example.test`;
    const { response: requestResponse, data: requestData } = await call(null, "/api/auth/register", {
      method: "POST",
      body: JSON.stringify({ email }),
    });
    assert.equal(requestResponse.status, 202, JSON.stringify(requestData));
    assert.equal((await pool.query("SELECT 1 FROM users WHERE email = $1", [email])).rowCount, 0);

    let registrationLink;
    for (let attempt = 0; attempt < 20 && !registrationLink; attempt += 1) {
      const search = await fetch(`${mailhogApi}/api/v2/search?kind=to&query=${encodeURIComponent(email)}`);
      const messages = await search.json();
      const body = decodeMailhogBodies(messages.items?.[0]?.MIME?.Parts ?? []);
      const match = body.match(/https?:\/\/[^\s<"]+\/cadastro\/confirmar\?token=[^\s<"]+/);
      if (match) registrationLink = match[0];
      else await new Promise((resolve) => setTimeout(resolve, 100));
    }
    assert.ok(registrationLink, "MailHog deve receber o link de cadastro");
    const token = new URL(registrationLink).searchParams.get("token");
    assert.ok(token);
    const registrationExpiry = await pool.query(
      `SELECT EXTRACT(EPOCH FROM (expires_at - created_at)) AS ttl_seconds
       FROM registration_tokens WHERE email = $1`,
      [email]
    );
    assert.ok(registrationExpiry.rows[0].ttl_seconds >= 23 * 60 * 60);
    assert.ok(registrationExpiry.rows[0].ttl_seconds <= 25 * 60 * 60);
    const { response, data } = await call(null, "/api/auth/register/complete", {
      method: "POST",
      body: JSON.stringify({ name: `Tester ${label}`, token, password: "Integration-test-password" }),
    });
    assert.equal(response.status, 201, JSON.stringify(data));
    const cookie = response.headers.get("set-cookie")?.split(";")[0];
    assert.ok(cookie);
    userIds.push(data.user.id);
    return { cookie, user: data.user, token };
  }

  async function createTribe(actor, label) {
    const { response, data } = await call(actor, "/api/tribes", {
      method: "POST",
      body: JSON.stringify({
        name: `${marker} ${label}`,
        description: "Tribo criada pelo teste de integração.",
        category: "Games",
        format: "Online",
        city: "Belo Horizonte",
        neighborhood: "",
      }),
    });
    assert.equal(response.status, 201, JSON.stringify(data));
    tribeIds.push(data.tribe.id);
    return data.tribe;
  }

  async function createPost(actor, tribe, body, image) {
    const { response, data } = await call(actor, `/api/tribes/${tribe.id}/posts`, {
      method: "POST",
      body: JSON.stringify({ body, ...(image ? { image } : {}) }),
    });
    assert.equal(response.status, 201, JSON.stringify(data));
    return data.id;
  }

  async function requestImage(actor, contentPath) {
    return fetch(`${origin}${contentPath}`, {
      headers: actor ? { Cookie: actor.cookie } : {},
      redirect: "manual",
    });
  }

  async function requestSignedImage(location) {
    const signedUrl = new URL(location);
    const storageEndpoint = new URL(process.env.R2_ENDPOINT);
    const transport = storageEndpoint.protocol === "https:" ? https : http;
    return new Promise((resolve, reject) => {
      const request = transport.request({
        hostname: storageEndpoint.hostname,
        port: storageEndpoint.port || undefined,
        method: "GET",
        path: `${signedUrl.pathname}${signedUrl.search}`,
        headers: { host: signedUrl.host },
      }, (response) => {
        const chunks = [];
        response.on("data", (chunk) => chunks.push(chunk));
        response.on("end", () => resolve({
          statusCode: response.statusCode,
          headers: response.headers,
          data: Buffer.concat(chunks),
        }));
      });
      request.on("error", reject);
      request.end();
    });
  }

  t.after(async () => {
    if (tribeIds.length) {
      const { rows } = await pool.query(
        `SELECT i.image_key FROM content_images i JOIN feed_items f ON f.id = i.content_id
         WHERE f.tribe_id = ANY($1::uuid[]) AND i.image_key IS NOT NULL`,
        [tribeIds]
      );
      for (const row of rows) {
        try { await getObjectStorage().deleteObject(row.image_key); } catch {}
      }
    }
    if (userIds.length) {
      const { rows } = await pool.query(
        "SELECT image_key FROM user_profile_images WHERE user_id = ANY($1::uuid[]) AND image_key IS NOT NULL",
        [userIds]
      );
      for (const row of rows) {
        try { await getObjectStorage().deleteObject(row.image_key); } catch {}
      }
    }
    if (tribeIds.length) await pool.query("DELETE FROM tribes WHERE id = ANY($1::uuid[])", [tribeIds]);
    if (userIds.length) await pool.query("DELETE FROM users WHERE id = ANY($1::uuid[])", [userIds]);
    await pool.query("DELETE FROM registration_tokens WHERE email LIKE $1", [`${marker}-%`]);
    await pool.query("DELETE FROM email_queue WHERE email LIKE $1", [`${marker}-%`]);
    await pool.end();
  });

  const alice = await register("alice");
  const resetRequest = await call(null, "/api/auth/password-reset", {
    method: "POST",
    body: JSON.stringify({ email: "not-registered@example.test" }),
  });
  assert.equal(resetRequest.response.status, 202);
  assert.match(resetRequest.data.message, /Se este e-mail estiver cadastrado/);
  const rejectedOrigin = await call(null, "/api/auth/password-reset", {
    method: "POST",
    body: JSON.stringify({ email: "not-registered@example.test" }),
    headers: { Origin: "https://cross-origin.invalid" },
  });
  assert.equal(rejectedOrigin.response.status, 403);

  const { response: resetRequestResponse, data: resetRequestData } = await call(null, "/api/auth/password-reset", {
    method: "POST",
    body: JSON.stringify({ email: alice.user.email }),
  });
  assert.equal(resetRequestResponse.status, 202);
  assert.equal(resetRequestData.message, resetRequest.data.message);
  let resetLink;
  for (let attempt = 0; attempt < 20 && !resetLink; attempt += 1) {
    const search = await fetch(`${mailhogApi}/api/v2/search?kind=to&query=${encodeURIComponent(alice.user.email)}`);
    const messages = await search.json();
    const body = decodeMailhogBodies((messages.items ?? []).flatMap((message) => message.MIME?.Parts ?? []));
    const match = body.match(/https?:\/\/[^\s<"]+\/senha\/redefinir\?token=[^\s<"]+/);
    if (match) resetLink = match[0];
    else await new Promise((resolve) => setTimeout(resolve, 100));
  }
  assert.ok(resetLink, "MailHog deve receber o link de redefinição de senha");
  const resetToken = new URL(resetLink).searchParams.get("token");
  for (const weak of ["Ab!", "semmaiuscula!", "SemEspecial1", "Sem espaço 1"]) {
    const rejected = await call(null, "/api/auth/password-reset/complete", {
      method: "POST",
      body: JSON.stringify({ token: resetToken, password: weak }),
    });
    assert.equal(rejected.response.status, 400, `senha fraca aceita: ${weak}`);
  }
  const { response: resetResponse, data: resetData } = await call(null, "/api/auth/password-reset/complete", {
    method: "POST",
    body: JSON.stringify({ token: resetToken, password: "New-integration-test-password" }),
  });
  assert.equal(resetResponse.status, 200, JSON.stringify(resetData));
  assert.equal(resetData.user.id, alice.user.id);
  const resetCookie = resetResponse.headers.get("set-cookie")?.split(";")[0];
  assert.ok(resetCookie);
  assert.equal((await call(alice, "/api/auth/me")).data.user, null);
  const resetSession = { cookie: resetCookie, user: alice.user };
  assert.equal((await call(resetSession, "/api/auth/me")).data.user.id, alice.user.id);
  assert.equal((await call(null, "/api/auth/login", {
    method: "POST",
    body: JSON.stringify({ email: alice.user.email, password: "Integration-test-password" }),
  })).response.status, 401);
  alice.cookie = resetCookie;

  await pool.query("UPDATE user_sessions SET expires_at = CURRENT_TIMESTAMP + INTERVAL '6 days' WHERE user_id = $1", [alice.user.id]);
  const renewedSessionResponse = await call(alice, "/api/auth/me");
  assert.equal(renewedSessionResponse.response.status, 200);
  assert.match(renewedSessionResponse.response.headers.get("set-cookie") ?? "", /Max-Age=2592000/);
  const renewedExpiry = await pool.query("SELECT expires_at > CURRENT_TIMESTAMP + INTERVAL '29 days' AS renewed FROM user_sessions WHERE user_id = $1", [alice.user.id]);
  assert.equal(renewedExpiry.rows[0].renewed, true);

  const secondLogin = await call(null, "/api/auth/login", {
    method: "POST",
    body: JSON.stringify({ email: alice.user.email, password: "New-integration-test-password" }),
  });
  assert.equal(secondLogin.response.status, 200);
  const secondSession = { cookie: secondLogin.response.headers.get("set-cookie")?.split(";")[0], user: alice.user };
  assert.ok(secondSession.cookie);
  const secondSessionToken = decodeURIComponent(secondSession.cookie.slice("tribes_session=".length));
  const secondSessionRow = await pool.query("SELECT id FROM user_sessions WHERE token_hash = $1", [digestSessionToken(secondSessionToken)]);
  assert.ok(secondSessionRow.rows[0]);

  await pool.query(
    `UPDATE user_sessions
     SET created_at = CURRENT_TIMESTAMP - INTERVAL '84 days',
          expires_at = CURRENT_TIMESTAMP + INTERVAL '1 day'
      WHERE id = $1`,
    [secondSessionRow.rows[0].id]
  );
  const cappedRenewal = await call(secondSession, "/api/auth/me");
  assert.equal(cappedRenewal.data.user.id, alice.user.id);
  const cappedCookie = cappedRenewal.response.headers.get("set-cookie") ?? "";
  const cappedMaxAge = Number(cappedCookie.match(/Max-Age=(\d+)/)?.[1]);
  assert.ok(cappedMaxAge > 0 && cappedMaxAge <= 6 * 24 * 60 * 60, `Max-Age inesperado: ${cappedCookie}`);

  await pool.query(
    `UPDATE user_sessions
      SET created_at = CURRENT_TIMESTAMP - INTERVAL '91 days',
          expires_at = CURRENT_TIMESTAMP + INTERVAL '30 days'
      WHERE id = $1`,
    [secondSessionRow.rows[0].id]
  );
  assert.equal((await call(secondSession, "/api/auth/me")).data.user, null);

  const thirdLogin = await call(null, "/api/auth/login", {
    method: "POST",
    body: JSON.stringify({ email: alice.user.email, password: "New-integration-test-password" }),
  });
  const thirdSession = { cookie: thirdLogin.response.headers.get("set-cookie")?.split(";")[0], user: alice.user };
  assert.ok(thirdSession.cookie);

  const passwordChangePath = "/api/auth/password-change";
  const unauthorizedPasswordChange = await call(null, passwordChangePath, {
    method: "POST",
    body: JSON.stringify({ currentPassword: "New-integration-test-password", newPassword: "Changed-integration-password", confirmPassword: "Changed-integration-password" }),
  });
  assert.equal(unauthorizedPasswordChange.response.status, 401);
  const wrongCurrentPassword = await call(alice, passwordChangePath, {
    method: "POST",
    body: JSON.stringify({ currentPassword: "wrong-password", newPassword: "Changed-integration-password", confirmPassword: "Changed-integration-password" }),
  });
  assert.equal(wrongCurrentPassword.response.status, 401);
  const mismatchedPasswordConfirmation = await call(alice, passwordChangePath, {
    method: "POST",
    body: JSON.stringify({ currentPassword: "New-integration-test-password", newPassword: "Changed-integration-password", confirmPassword: "Different-integration-password" }),
  });
  assert.equal(mismatchedPasswordConfirmation.response.status, 400);
  const weakNewPassword = await call(alice, passwordChangePath, {
    method: "POST",
    body: JSON.stringify({ currentPassword: "New-integration-test-password", newPassword: "weak", confirmPassword: "weak" }),
  });
  assert.equal(weakNewPassword.response.status, 400);
  assert.equal((await call(alice, "/api/auth/sessions")).response.status, 404);

  const passwordChange = await call(alice, passwordChangePath, {
    method: "POST",
    body: JSON.stringify({ currentPassword: "New-integration-test-password", newPassword: "Changed-integration-password", confirmPassword: "Changed-integration-password" }),
  });
  assert.equal(passwordChange.response.status, 200, JSON.stringify(passwordChange.data));
  assert.equal((await call(alice, "/api/auth/me")).data.user.id, alice.user.id);
  assert.equal((await call(thirdSession, "/api/auth/me")).data.user, null);
  const remainingSessions = await pool.query("SELECT token_hash FROM user_sessions WHERE user_id = $1", [alice.user.id]);
  assert.deepEqual(remainingSessions.rows.map((row) => row.token_hash), [digestSessionToken(decodeURIComponent(alice.cookie.slice("tribes_session=".length)))]);
  assert.equal((await call(null, "/api/auth/login", {
    method: "POST",
    body: JSON.stringify({ email: alice.user.email, password: "New-integration-test-password" }),
  })).response.status, 401);
  assert.equal((await call(null, "/api/auth/login", {
    method: "POST",
    body: JSON.stringify({ email: alice.user.email, password: "Changed-integration-password" }),
  })).response.status, 200);

  const reusedToken = await call(null, "/api/auth/register/complete", {
    method: "POST",
    body: JSON.stringify({ name: "Tester alice", token: alice.token, password: "Another-valid-password" }),
  });
  assert.equal(reusedToken.response.status, 400);
  const bob = await register("bob");
  const empty = await register("empty");

  assert.equal((await call(null, "/api/dm/conversations")).response.status, 401);
  const dmUserSearch = await call(alice, "/api/dm/users?q=Tester%20bob");
  assert.equal(dmUserSearch.response.status, 200);
  assert.equal(dmUserSearch.data.users.length, 1);
  assert.equal(dmUserSearch.data.users[0].id, bob.user.id);
  assert.equal("email" in dmUserSearch.data.users[0], false);
  assert.equal((await call(alice, `/api/dm/users?q=${encodeURIComponent(alice.user.name)}`)).data.users.length, 0);

  assert.equal((await call(alice, "/api/dm/conversations", {
    method: "POST", body: JSON.stringify({ recipientId: alice.user.id }),
  })).response.status, 400);
  assert.equal((await call(alice, "/api/dm/conversations", {
    method: "POST", body: JSON.stringify({ recipientId: "00000000-0000-4000-8000-000000000000" }),
  })).response.status, 404);
  const openedConversation = await call(alice, "/api/dm/conversations", {
    method: "POST", body: JSON.stringify({ recipientId: bob.user.id }),
  });
  assert.equal(openedConversation.response.status, 201);
  const directConversationId = openedConversation.data.conversation.id;
  const reopenedConversation = await call(bob, "/api/dm/conversations", {
    method: "POST", body: JSON.stringify({ recipientId: alice.user.id }),
  });
  assert.equal(reopenedConversation.response.status, 201);
  assert.equal(reopenedConversation.data.conversation.id, directConversationId);
  const directMessagesPath = `/api/dm/conversations/${directConversationId}/messages`;
  assert.equal((await call(empty, `/api/dm/conversations/${directConversationId}`)).response.status, 404);
  assert.equal((await call(empty, directMessagesPath)).response.status, 404);
  assert.equal((await call(empty, directMessagesPath, {
    method: "POST", body: JSON.stringify({ body: "Mensagem de fora." }),
  })).response.status, 404);
  assert.equal((await call(alice, directMessagesPath, {
    method: "POST", body: JSON.stringify({ body: "   " }),
  })).response.status, 400);
  assert.equal((await call(alice, directMessagesPath, {
    method: "POST", body: JSON.stringify({ body: "x".repeat(1001) }),
  })).response.status, 400);
  const sentDirectMessage = await call(alice, directMessagesPath, {
    method: "POST", body: JSON.stringify({ body: "Oi, Bob!" }),
  });
  assert.equal(sentDirectMessage.response.status, 201);
  assert.equal(sentDirectMessage.data.message.sender.id, alice.user.id);
  assert.equal(sentDirectMessage.data.message.isMine, true);
  const bobInbox = await call(bob, "/api/dm/conversations");
  assert.equal(bobInbox.data.conversations[0].unreadCount, 1);
  const bobDirectMessages = await call(bob, directMessagesPath);
  assert.equal(bobDirectMessages.response.status, 200);
  assert.equal(bobDirectMessages.data.messages[0].body, "Oi, Bob!");
  assert.equal(bobDirectMessages.data.messages[0].isMine, false);
  assert.equal((await call(bob, "/api/dm/conversations")).data.conversations[0].unreadCount, 0);
  assert.equal((await call(alice, `/api/dm/conversations/${directConversationId}`)).data.conversation.peer.id, bob.user.id);

  const profileImage = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+nmL8AAAAASUVORK5CYII=";
  const profileUpdate = await call(alice, "/api/profile", {
    method: "PATCH",
    body: JSON.stringify({ name: "Alice Perfil", aboutMe: "Gosto de jogos e comunidades.", interests: [], avatar: profileImage }),
  });
  assert.equal(profileUpdate.response.status, 200, JSON.stringify(profileUpdate.data));
  assert.equal(profileUpdate.data.user.name, "Alice Perfil");
  assert.equal(profileUpdate.data.user.aboutMe, "Gosto de jogos e comunidades.");
  assert.equal(profileUpdate.data.user.avatarUrl, `/api/users/${alice.user.id}/avatar`);
  const currentProfile = await call(alice, "/api/auth/me");
  assert.equal(currentProfile.data.user.name, "Alice Perfil");
  assert.equal(currentProfile.data.user.avatarUrl, `/api/users/${alice.user.id}/avatar`);
  const storedAvatar = await pool.query(
    "SELECT image_key, image_data, byte_size FROM user_profile_images WHERE user_id = $1",
    [alice.user.id]
  );
  assert.match(storedAvatar.rows[0].image_key, new RegExp(`^avatars/${alice.user.id}/`));
  assert.equal(storedAvatar.rows[0].image_data, null);
  assert.equal(storedAvatar.rows[0].byte_size, Buffer.from(profileImage.split(",")[1], "base64").length);
  const publicProfile = await call(bob, `/api/users/${alice.user.id}/profile`);
  assert.equal(publicProfile.response.status, 200);
  assert.deepEqual(publicProfile.data.profile, {
    id: alice.user.id,
    name: "Alice Perfil",
    aboutMe: "Gosto de jogos e comunidades.",
    city: "",
    interests: [],
    avatarUrl: `/api/users/${alice.user.id}/avatar`,
    isMe: false,
  });
  assert.equal("email" in publicProfile.data.profile, false);
  const selfProfile = await call(alice, `/api/users/${alice.user.id}/profile`);
  assert.equal(selfProfile.data.profile.isMe, true);
  const publicAvatar = await requestImage(bob, `/api/users/${alice.user.id}/avatar`);
  assert.equal(publicAvatar.status, 302);
  assert.equal(new URL(publicAvatar.headers.get("location")).searchParams.get("X-Amz-Expires"), "300");
  const avatarBytes = await getObjectStorage().getObject(storedAvatar.rows[0].image_key);
  assert.equal(avatarBytes.mimeType, "image/png");
  assert.equal(avatarBytes.data.length, Buffer.from(profileImage.split(",")[1], "base64").length);
  const removedAvatar = await call(alice, "/api/profile", {
    method: "PATCH",
    body: JSON.stringify({ name: "Alice Perfil", aboutMe: "Gosto de jogos e comunidades.", city: "", interests: [], avatar: null }),
  });
  assert.equal(removedAvatar.response.status, 200);
  assert.equal(removedAvatar.data.user.avatarUrl, null);
  assert.equal((await call(bob, `/api/users/${alice.user.id}/avatar`)).response.status, 404);
  assert.equal((await pool.query("SELECT 1 FROM user_profile_images WHERE user_id = $1", [alice.user.id])).rowCount, 0);
  const legacyAvatarBytes = Buffer.from(profileImage.split(",")[1], "base64");
  await pool.query(
    `INSERT INTO user_profile_images (user_id, mime_type, image_data, byte_size)
     VALUES ($1, 'image/png', $2, $3)`,
    [alice.user.id, legacyAvatarBytes, legacyAvatarBytes.length]
  );
  const transferredAvatar = await transferLegacyImageRow(pool, {
    table: "user_profile_images",
    id: alice.user.id,
  });
  assert.equal(transferredAvatar.transferred, true);
  const legacyAvatarRecord = await pool.query(
    "SELECT image_key, image_data FROM user_profile_images WHERE user_id = $1",
    [alice.user.id]
  );
  assert.ok(legacyAvatarRecord.rows[0].image_key);
  assert.deepEqual(legacyAvatarRecord.rows[0].image_data, legacyAvatarBytes);
  assert.equal((await requestImage(bob, `/api/users/${alice.user.id}/avatar`)).status, 302);
  const removeLegacyAvatar = await call(alice, "/api/profile", {
    method: "PATCH",
    body: JSON.stringify({ name: "Alice Perfil", aboutMe: "Gosto de jogos e comunidades.", city: "", interests: [], avatar: null }),
  });
  assert.equal(removeLegacyAvatar.response.status, 200);
  const preservedAvatarRecord = await pool.query(
    "SELECT image_key, image_data, is_deleted FROM user_profile_images WHERE user_id = $1",
    [alice.user.id]
  );
  assert.equal(preservedAvatarRecord.rows[0].image_key, null);
  assert.equal(preservedAvatarRecord.rows[0].is_deleted, true);
  assert.deepEqual(preservedAvatarRecord.rows[0].image_data, legacyAvatarBytes);
  assert.equal((await call(alice, "/api/auth/me")).data.user.avatarUrl, null);
  assert.equal((await call(bob, `/api/users/${alice.user.id}/avatar`)).response.status, 404);
  assert.equal((await call(null, "/api/profile", { method: "PATCH", body: JSON.stringify({ name: "Hacker", aboutMe: "" }) })).response.status, 401);
  assert.equal((await call(alice, "/api/profile", {
    method: "PATCH", body: JSON.stringify({ name: "A", aboutMe: "" }),
  })).response.status, 400);
  assert.equal((await call(alice, "/api/profile", {
    method: "PATCH", body: JSON.stringify({ name: "Alice Perfil", aboutMe: "x".repeat(501) }),
  })).response.status, 400);

  assert.equal((await call(null, "/api/feed")).response.status, 401);
  assert.equal((await call(null, "/api/saved")).response.status, 401);
  assert.equal((await call(null, "/api/events")).response.status, 401);
  assert.deepEqual((await call(empty, "/api/tribes?mine=true")).data.tribes, []);
  const tribeOne = await createTribe(alice, "one");
  const tribeTwo = await createTribe(alice, "two");
  const outsiderTribe = await createTribe(bob, "private-to-bob");

  const privatePassword = "Senha privada de teste!";
  const privatePayload = {
    name: `${marker} privada`, description: "Tribo privada de teste.", category: "Games",
    format: "Online", city: "Belo Horizonte", neighborhood: "", isPrivate: true,
    password: privatePassword, passwordConfirmation: privatePassword,
  };
  const createPrivate = (payload) => call(alice, "/api/tribes", { method: "POST", body: JSON.stringify(payload) });
  for (const payload of [
    { ...privatePayload, passwordConfirmation: "diferente" },
    { ...privatePayload, password: "" },
    { ...privatePayload, passwordConfirmation: "" },
    { ...privatePayload, passwordConfirmation: undefined },
  ]) assert.equal((await createPrivate(payload)).response.status, 400);
  const privateCreated = await createPrivate(privatePayload);
  assert.equal(privateCreated.response.status, 201);
  const privateTribe = privateCreated.data.tribe;
  tribeIds.push(privateTribe.id);
  assert.equal(privateTribe.isPrivate, true);
  const storedPrivate = (await pool.query("SELECT is_private, password_hash FROM tribes WHERE id = $1", [privateTribe.id])).rows[0];
  assert.equal(storedPrivate.is_private, true);
  assert.notEqual(storedPrivate.password_hash, privatePassword);
  assert.match(storedPrivate.password_hash, /^scrypt\$/);
  const publicStored = (await pool.query("SELECT is_private, password_hash FROM tribes WHERE id = $1", [tribeOne.id])).rows[0];
  assert.deepEqual(publicStored, { is_private: false, password_hash: null });
  const privateList = await call(bob, "/api/tribes");
  assert.equal(privateList.data.tribes.find((tribe) => tribe.id === privateTribe.id)?.isPrivate, true);
  assert.equal(privateList.data.tribes.find((tribe) => tribe.id === tribeOne.id)?.isPrivate, false);
  const privateDetail = await call(null, `/api/tribes/${privateTribe.id}`);
  for (const data of [privateCreated.data, privateList.data, privateDetail.data]) {
    const serialized = JSON.stringify(data);
    assert.equal(serialized.includes(privatePassword), false);
    assert.equal(serialized.includes(storedPrivate.password_hash), false);
    assert.equal(serialized.includes("password_hash"), false);
  }
  const privateJoinPath = `/api/tribes/${privateTribe.id}/join`;
  assert.equal((await call(null, privateJoinPath, { method: "POST", body: JSON.stringify({ password: privatePassword }) })).response.status, 401);
  assert.equal((await call(bob, privateJoinPath, { method: "POST" })).response.status, 403);
  assert.equal((await call(bob, privateJoinPath, { method: "POST", body: JSON.stringify({ password: "errada" }) })).response.status, 403);
  assert.equal((await pool.query("SELECT 1 FROM tribe_memberships WHERE tribe_id = $1 AND user_id = $2 AND status = 'active'", [privateTribe.id, bob.user.id])).rowCount, 0);
  assert.equal((await call(bob, privateJoinPath, { method: "POST", body: JSON.stringify({ password: privatePassword }) })).response.status, 200);
  assert.equal((await call(bob, privateJoinPath, { method: "POST", body: JSON.stringify({ password: privatePassword }) })).response.status, 200);
  assert.equal((await pool.query("SELECT 1 FROM tribe_memberships WHERE tribe_id = $1 AND user_id = $2 AND status = 'active'", [privateTribe.id, bob.user.id])).rowCount, 1);
  assert.equal((await call(bob, `/api/tribes/${privateTribe.id}/membership`, { method: "DELETE" })).response.status, 200);
  assert.equal((await call(bob, privateJoinPath, { method: "POST" })).response.status, 403);
  assert.equal((await call(bob, privateJoinPath, { method: "POST", body: JSON.stringify({ password: privatePassword }) })).response.status, 200);
  for (let attempt = 0; attempt < 6; attempt += 1) {
    assert.equal((await call(bob, privateJoinPath, { method: "POST", body: JSON.stringify({ password: "errada" }) })).response.status, 403);
  }
  const limitedJoin = await call(bob, privateJoinPath, { method: "POST", body: JSON.stringify({ password: privatePassword }) });
  assert.equal(limitedJoin.response.status, 429);
  assert.equal(limitedJoin.response.headers.get("retry-after"), "60");

  const handoffTribe = await createTribe(alice, "moderator-handoff");
  assert.equal((await call(bob, `/api/tribes/${handoffTribe.id}/join`, { method: "POST" })).response.status, 200);
  assert.equal((await call(empty, `/api/tribes/${handoffTribe.id}/join`, { method: "POST" })).response.status, 200);
  await pool.query(
    `UPDATE tribe_memberships
     SET joined_at = CASE user_id WHEN $2 THEN $4::timestamptz ELSE $5::timestamptz END
     WHERE tribe_id = $1 AND user_id = ANY($3::uuid[])`,
    [handoffTribe.id, bob.user.id, [bob.user.id, empty.user.id], "2020-01-01T00:00:00Z", "2021-01-01T00:00:00Z"]
  );
  const handoff = await call(alice, `/api/tribes/${handoffTribe.id}/membership`, { method: "DELETE" });
  assert.equal(handoff.response.status, 200, JSON.stringify(handoff.data));
  assert.deepEqual(handoff.data, { isMember: false, tribeDeleted: false, moderatorId: bob.user.id });
  const moderatorState = await pool.query(
    `SELECT t.created_by, t.moderator_id, m.status
     FROM tribes t JOIN tribe_memberships m ON m.tribe_id = t.id AND m.user_id = $2
     WHERE t.id = $1`,
    [handoffTribe.id, alice.user.id]
  );
  assert.equal(moderatorState.rows[0].created_by, alice.user.id);
  assert.equal(moderatorState.rows[0].moderator_id, bob.user.id);
  assert.equal(moderatorState.rows[0].status, "left");
  const bobEdit = await call(bob, `/api/tribes/${handoffTribe.id}`, {
    method: "PATCH",
    body: JSON.stringify({
      name: handoffTribe.name,
      description: "Atualizada pelo novo moderador.",
      category: handoffTribe.category,
      format: handoffTribe.format,
      city: handoffTribe.city,
      neighborhood: handoffTribe.neighborhood,
    }),
  });
  assert.equal(bobEdit.response.status, 200, JSON.stringify(bobEdit.data));
  assert.equal((await call(alice, `/api/tribes/${handoffTribe.id}`, {
    method: "PATCH",
    body: JSON.stringify({
      name: handoffTribe.name,
      description: handoffTribe.description,
      category: handoffTribe.category,
      format: handoffTribe.format,
      city: handoffTribe.city,
      neighborhood: handoffTribe.neighborhood,
    }),
  })).response.status, 404);
  const bobManagedTribes = await call(bob, "/api/tribes?managed=true");
  assert.equal(bobManagedTribes.response.status, 200);
  assert.equal(bobManagedTribes.data.tribes.find((tribe) => tribe.id === handoffTribe.id)?.isModerator, true);
  const transferredMembers = await call(bob, `/api/tribes/${handoffTribe.id}/members`);
  assert.equal(transferredMembers.data.members.find((member) => member.id === bob.user.id)?.isModerator, true);

  const lastMemberTribe = await createTribe(alice, "last-member-deletion");
  const autoDeletePostId = await createPost(alice, lastMemberTribe, "Conteúdo removido junto com a tribo.", profileImage);
  const autoDeleteImage = await pool.query("SELECT image_key FROM content_images WHERE content_id = $1", [autoDeletePostId]);
  assert.ok(autoDeleteImage.rows[0].image_key);
  const lastMemberExit = await call(alice, `/api/tribes/${lastMemberTribe.id}/membership`, { method: "DELETE" });
  assert.equal(lastMemberExit.response.status, 200, JSON.stringify(lastMemberExit.data));
  assert.deepEqual(lastMemberExit.data, { isMember: false, tribeDeleted: true });
  assert.equal((await pool.query("SELECT 1 FROM tribes WHERE id = $1", [lastMemberTribe.id])).rowCount, 0);
  assert.equal((await pool.query("SELECT 1 FROM tribe_memberships WHERE tribe_id = $1", [lastMemberTribe.id])).rowCount, 0);
  assert.equal((await pool.query("SELECT 1 FROM feed_items WHERE id = $1", [autoDeletePostId])).rowCount, 0);
  assert.equal((await call(null, `/api/tribes/${lastMemberTribe.id}`)).response.status, 404);
  await assert.rejects(getObjectStorage().getObject(autoDeleteImage.rows[0].image_key));

  const tribeToDelete = await createTribe(alice, "for-deletion");
  const deletionPostId = await createPost(
    alice,
    tribeToDelete,
    "Publicação que será removida com a tribo.",
    "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+nmL8AAAAASUVORK5CYII="
  );
  const deletionImage = await pool.query("SELECT image_key FROM content_images WHERE content_id = $1", [deletionPostId]);
  assert.ok(deletionImage.rows[0].image_key);
  const deleteTribePath = `/api/tribes/${tribeToDelete.id}`;
  const deletePayload = { confirmationName: tribeToDelete.name };
  assert.equal((await call(null, deleteTribePath, {
    method: "DELETE", body: JSON.stringify(deletePayload),
  })).response.status, 401);
  assert.equal((await call(bob, deleteTribePath, {
    method: "DELETE", body: JSON.stringify(deletePayload),
  })).response.status, 404);
  assert.equal((await call(alice, deleteTribePath, {
    method: "DELETE", body: JSON.stringify({ confirmationName: "Nome incorreto" }),
  })).response.status, 400);
  assert.equal((await pool.query("SELECT 1 FROM tribes WHERE id = $1", [tribeToDelete.id])).rowCount, 1);
  const deletedTribeResponse = await call(alice, deleteTribePath, {
    method: "DELETE", body: JSON.stringify(deletePayload),
  });
  assert.equal(deletedTribeResponse.response.status, 200, JSON.stringify(deletedTribeResponse.data));
  assert.deepEqual(deletedTribeResponse.data, { ok: true });
  assert.equal((await pool.query("SELECT 1 FROM tribes WHERE id = $1", [tribeToDelete.id])).rowCount, 0);
  assert.equal((await pool.query("SELECT 1 FROM feed_items WHERE id = $1", [deletionPostId])).rowCount, 0);
  await assert.rejects(getObjectStorage().getObject(deletionImage.rows[0].image_key));

  assert.equal((await call(null, `/api/tribes/${tribeOne.id}/posts`, {
    method: "POST", body: JSON.stringify({ body: "Sem sessão" }),
  })).response.status, 401);
  assert.equal((await call(empty, `/api/tribes/${tribeOne.id}/posts`, {
    method: "POST", body: JSON.stringify({ body: "Sem associação" }),
  })).response.status, 403);

  const { response: loginResponse, data: loginData } = await call(null, "/api/auth/login", {
    method: "POST",
    body: JSON.stringify({ email: alice.user.email, password: "Changed-integration-password" }),
  });
  assert.equal(loginResponse.status, 200);
  assert.equal(loginData.user.id, alice.user.id);
  const { response: badLogin } = await call(null, "/api/auth/login", {
    method: "POST",
    body: JSON.stringify({ email: alice.user.email, password: "wrong-password" }),
  });
  assert.equal(badLogin.status, 401);

  assert.equal((await call(bob, `/api/tribes/${tribeOne.id}/join`, { method: "POST" })).response.status, 200);
  assert.equal((await call(bob, `/api/tribes/${tribeOne.id}/join`, { method: "POST" })).response.status, 200);

  const postId = await createPost(alice, tribeOne, "Uma publicação para todos os membros.");
  assert.equal((await call(null, `/api/content/${postId}`)).response.status, 401);
  const directPost = await call(alice, `/api/content/${postId}`);
  assert.equal(directPost.response.status, 200, JSON.stringify(directPost.data));
  assert.equal(directPost.data.item.id, postId);
  assert.equal(directPost.data.item.body, "Uma publicação para todos os membros.");
  assert.equal(directPost.data.item.tribe.id, tribeOne.id);
  assert.equal((await call(empty, `/api/content/${postId}`)).response.status, 404);
  const pollResponse = await call(alice, `/api/tribes/${tribeOne.id}/posts`, {
    method: "POST",
    body: JSON.stringify({ body: "Qual atividade devemos organizar?", pollOptions: ["Cinema", "Jogos", "Piquenique"] }),
  });
  assert.equal(pollResponse.response.status, 201, JSON.stringify(pollResponse.data));
  const pollId = pollResponse.data.id;
  const pollFeed = await call(alice, "/api/feed");
  const pollItem = pollFeed.data.items.find((item) => item.id === pollId);
  assert.equal(pollItem.type, "poll");
  assert.equal(pollItem.poll.options.length, 3);
  assert.equal(pollItem.poll.totalVotes, 0);
  assert.deepEqual(pollItem.poll.votedOptionIds, []);
  assert.equal(pollItem.poll.multiple, false);
  assert.equal((await call(null, `/api/content/${pollId}/vote`, {
    method: "POST", body: JSON.stringify({ optionId: pollItem.poll.options[0].id }),
  })).response.status, 401);
  assert.equal((await call(empty, `/api/content/${pollId}/vote`, {
    method: "POST", body: JSON.stringify({ optionId: pollItem.poll.options[0].id }),
  })).response.status, 404);
  assert.equal((await call(alice, `/api/content/${pollId}/vote`, {
    method: "POST", body: JSON.stringify({ optionId: "00000000-0000-4000-8000-000000000000" }),
  })).response.status, 400);
  const firstVote = await call(bob, `/api/content/${pollId}/vote`, {
    method: "POST", body: JSON.stringify({ optionId: pollItem.poll.options[0].id }),
  });
  assert.equal(firstVote.response.status, 200);
  assert.equal(firstVote.data.totalVotes, 1);
  const changedVote = await call(bob, `/api/content/${pollId}/vote`, {
    method: "POST", body: JSON.stringify({ optionId: pollItem.poll.options[1].id }),
  });
  assert.equal(changedVote.response.status, 200);
  assert.equal(changedVote.data.totalVotes, 1);
  assert.deepEqual(changedVote.data.votedOptionIds, [pollItem.poll.options[1].id]);
  const updatedPollFeed = await call(bob, "/api/feed");
  const updatedPoll = updatedPollFeed.data.items.find((item) => item.id === pollId);
  assert.equal(updatedPoll.poll.totalVotes, 1);
  assert.equal(updatedPoll.poll.options.find((option) => option.id === pollItem.poll.options[1].id).votes, 1);
  const multiPoll = await call(alice, `/api/tribes/${tribeOne.id}/posts`, {
    method: "POST",
    body: JSON.stringify({ body: "Quais dias servem?", pollOptions: ["Sexta", "Sábado", "Domingo"], pollMultiple: true }),
  });
  assert.equal(multiPoll.response.status, 201, JSON.stringify(multiPoll.data));
  const multiPollItem = (await call(bob, "/api/feed")).data.items.find((item) => item.id === multiPoll.data.id);
  assert.equal(multiPollItem.poll.multiple, true);
  const [friday, saturday] = multiPollItem.poll.options;
  await call(bob, `/api/content/${multiPoll.data.id}/vote`, { method: "POST", body: JSON.stringify({ optionId: friday.id }) });
  const secondChoice = await call(bob, `/api/content/${multiPoll.data.id}/vote`, { method: "POST", body: JSON.stringify({ optionId: saturday.id }) });
  assert.equal(secondChoice.response.status, 200);
  assert.equal(secondChoice.data.totalVotes, 1);
  assert.deepEqual(new Set(secondChoice.data.votedOptionIds), new Set([friday.id, saturday.id]));
  const toggledOff = await call(bob, `/api/content/${multiPoll.data.id}/vote`, { method: "POST", body: JSON.stringify({ optionId: friday.id }) });
  assert.deepEqual(toggledOff.data.votedOptionIds, [saturday.id]);
  assert.equal((await call(alice, `/api/tribes/${tribeOne.id}/posts`, {
    method: "POST",
    body: JSON.stringify({ body: "Enquete inválida", pollMultiple: "sim", pollOptions: ["A", "B"] }),
  })).response.status, 400);
  const pollWithImage = await call(alice, `/api/tribes/${tribeOne.id}/posts`, {
    method: "POST",
    body: JSON.stringify({ body: "Enquete com imagem", pollOptions: ["Sim", "Não"], image: "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+nmL8AAAAASUVORK5CYII=" }),
  });
  assert.equal(pollWithImage.response.status, 201, JSON.stringify(pollWithImage.data));
  const eventWithImage = await call(alice, `/api/tribes/${tribeOne.id}/events`, {
    method: "POST",
    body: JSON.stringify({
      body: "Evento com imagem", title: "Encontro", location: "Praça", startsAt: "2030-01-01T18:00:00.000Z",
      image: "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+nmL8AAAAASUVORK5CYII=",
    }),
  });
  assert.equal(eventWithImage.response.status, 201, JSON.stringify(eventWithImage.data));
  const imageFeed = (await call(alice, "/api/feed")).data.items;
  assert.ok(imageFeed.find((item) => item.id === eventWithImage.data.id).imageUrl);
  assert.ok(imageFeed.find((item) => item.id === pollWithImage.data.id).imageUrl);
  assert.equal((await call(alice, `/api/tribes/${tribeOne.id}/posts`, {
    method: "POST",
    body: JSON.stringify({ body: "Enquete inválida", pollOptions: ["Só uma opção"] }),
  })).response.status, 400);
  assert.equal((await call(alice, `/api/tribes/${tribeOne.id}/posts`, {
    method: "POST",
    body: JSON.stringify({ body: "Enquete duplicada", pollOptions: ["Igual", "igual"] }),
  })).response.status, 400);

  const bobProfileForFilters = await call(bob, "/api/profile", {
    method: "PATCH",
    body: JSON.stringify({ name: bob.user.name, aboutMe: "", city: "Belo Horizonte - MG", interests: ["Games", "Leitura"] }),
  });
  assert.equal(bobProfileForFilters.response.status, 200);
  const membersResponse = await call(alice, `/api/tribes/${tribeOne.id}/members`);
  assert.equal(membersResponse.response.status, 200);
  assert.deepEqual(new Set(membersResponse.data.members.map((member) => member.id)), new Set([alice.user.id, bob.user.id]));
  const bobDirectoryEntry = membersResponse.data.members.find((member) => member.id === bob.user.id);
  assert.equal(bobDirectoryEntry.city, "Belo Horizonte - MG");
  assert.deepEqual(bobDirectoryEntry.interests, ["Games", "Leitura"]);
  assert.equal((await call(empty, `/api/tribes/${tribeOne.id}/members`)).response.status, 404);

  const chatPath = `/api/tribes/${tribeOne.id}/messages`;
  assert.equal((await call(null, chatPath)).response.status, 401);
  assert.equal((await call(empty, chatPath)).response.status, 404);
  const firstChatMessage = await call(alice, chatPath, {
    method: "POST", body: JSON.stringify({ body: "Oi, pessoal!" }),
  });
  assert.equal(firstChatMessage.response.status, 201, JSON.stringify(firstChatMessage.data));
  assert.equal(firstChatMessage.data.message.body, "Oi, pessoal!");
  assert.equal(firstChatMessage.data.message.author.id, alice.user.id);
  assert.equal(firstChatMessage.data.message.isMine, true);
  assert.equal((await call(bob, chatPath)).data.messages.find((message) => message.id === firstChatMessage.data.message.id).isMine, false);
  const aliceMessagePath = `${chatPath}/${firstChatMessage.data.message.id}`;
  assert.equal((await call(bob, aliceMessagePath, {
    method: "PATCH", body: JSON.stringify({ body: "Tentativa de edição." }),
  })).response.status, 404);
  assert.equal((await call(bob, aliceMessagePath, { method: "DELETE" })).response.status, 404);
  const editedChatMessage = await call(alice, aliceMessagePath, {
    method: "PATCH", body: JSON.stringify({ body: "Oi, pessoal! (editada)" }),
  });
  assert.equal(editedChatMessage.response.status, 200);
  assert.equal(editedChatMessage.data.message.body, "Oi, pessoal! (editada)");
  assert.ok(editedChatMessage.data.message.editedAt);
  const aliceChat = await call(alice, chatPath);
  assert.equal(aliceChat.data.messages.find((message) => message.id === firstChatMessage.data.message.id).editedAt, editedChatMessage.data.message.editedAt);
  assert.equal((await call(alice, aliceMessagePath, { method: "DELETE" })).response.status, 200);
  assert.ok(!(await call(bob, chatPath)).data.messages.some((message) => message.id === firstChatMessage.data.message.id));
  const bobChat = await call(bob, chatPath);
  assert.equal(bobChat.response.status, 200);
  const bobMessage = await call(bob, chatPath, {
    method: "POST", body: JSON.stringify({ body: "Mensagem do Bob" }),
  });
  assert.equal(bobMessage.response.status, 201);
  const bobMessagePath = `${chatPath}/${bobMessage.data.message.id}`;
  assert.equal((await call(alice, bobMessagePath, { method: "DELETE" })).response.status, 404);
  assert.equal((await call(alice, chatPath, {
    method: "POST", body: JSON.stringify({ body: "x".repeat(1001) }),
  })).response.status, 400);
  await pool.query(
    "UPDATE tribe_messages SET created_at = CURRENT_TIMESTAMP - INTERVAL '8 days' WHERE id = $1",
    [bobMessage.data.message.id]
  );
  const chatAfterRetention = await call(alice, chatPath);
  assert.equal(chatAfterRetention.response.status, 200);
  assert.ok(!chatAfterRetention.data.messages.some((message) => message.id === bobMessage.data.message.id));

  assert.equal((await call(bob, "/api/events")).response.status, 200);
  const imageData = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+nmL8AAAAASUVORK5CYII=";
  assert.equal((await call(empty, `/api/tribes/${tribeOne.id}/posts`, {
    method: "POST", body: JSON.stringify({ body: "Sem associação", image: imageData }),
  })).response.status, 403);
  const imagePostId = await createPost(alice, tribeOne, "Publicação com imagem.", imageData);
  const storedPostImage = await pool.query(
    "SELECT image_key, image_data, byte_size FROM content_images WHERE content_id = $1",
    [imagePostId]
  );
  assert.match(storedPostImage.rows[0].image_key, /^content\//);
  assert.equal(storedPostImage.rows[0].image_data, null);
  assert.equal(storedPostImage.rows[0].byte_size, Buffer.from(imageData.split(",")[1], "base64").length);

  const legacyPostId = await createPost(alice, tribeOne, "Publicação legada com imagem.");
  const legacyImageBytes = Buffer.from(imageData.split(",")[1], "base64");
  await pool.query(
    `INSERT INTO content_images (content_id, mime_type, image_data, byte_size)
     VALUES ($1, 'image/png', $2, $3)`,
    [legacyPostId, legacyImageBytes, legacyImageBytes.length]
  );
  const transferredPost = await transferLegacyImageRow(pool, {
    table: "content_images",
    id: legacyPostId,
  });
  assert.equal(transferredPost.transferred, true);
  const preservedLegacyPost = await pool.query(
    "SELECT image_key, image_data FROM content_images WHERE content_id = $1",
    [legacyPostId]
  );
  assert.ok(preservedLegacyPost.rows[0].image_key);
  assert.deepEqual(preservedLegacyPost.rows[0].image_data, legacyImageBytes);
  assert.equal((await requestImage(alice, `/api/content/${legacyPostId}/image`)).status, 302);
  const failedTransferPostId = await createPost(alice, tribeOne, "Publicação cuja transferência falhará.");
  await pool.query(
    `INSERT INTO content_images (content_id, mime_type, image_data, byte_size)
     VALUES ($1, 'image/png', $2, $3)`,
    [failedTransferPostId, legacyImageBytes, legacyImageBytes.length]
  );
  const unavailableStorage = createObjectStorage({
    accountId: "integration-test",
    accessKeyId: "integration-test-access",
    secretAccessKey: "integration-test-secret",
    bucketName: "tribes-media",
    endpoint: "http://127.0.0.1:1",
  });
  await assert.rejects(
    transferLegacyImageRow(pool, {
      table: "content_images",
      id: failedTransferPostId,
      storage: unavailableStorage,
    }),
    { statusCode: 503 }
  );
  const failedTransferRecord = await pool.query(
    "SELECT image_key, image_data FROM content_images WHERE content_id = $1",
    [failedTransferPostId]
  );
  assert.equal(failedTransferRecord.rows[0].image_key, null);
  assert.deepEqual(failedTransferRecord.rows[0].image_data, legacyImageBytes);
  const invalidImage = await call(alice, `/api/tribes/${tribeOne.id}/posts`, {
    method: "POST",
    body: JSON.stringify({ body: "Imagem inválida.", image: "data:image/png;base64,ZmFrZQ==" }),
  });
  assert.equal(invalidImage.response.status, 400);
  const imageResponse = await requestImage(alice, `/api/content/${imagePostId}/image`);
  assert.equal(imageResponse.status, 302);
  const signedImageUrl = imageResponse.headers.get("location");
  assert.equal(new URL(signedImageUrl).searchParams.get("X-Amz-Expires"), "300");
  assert.equal((await requestImage(null, `/api/content/${imagePostId}/image`)).status, 401);
  const signedImageResponse = await requestSignedImage(signedImageUrl);
  assert.equal(signedImageResponse.statusCode, 200);
  assert.equal(signedImageResponse.headers["content-type"], "image/png");
  assert.deepEqual(signedImageResponse.data, Buffer.from(imageData.split(",")[1], "base64"));
  const postImageBytes = await getObjectStorage().getObject(storedPostImage.rows[0].image_key);
  assert.equal(postImageBytes.mimeType, "image/png");
  assert.equal(postImageBytes.data.length, Buffer.from(imageData.split(",")[1], "base64").length);
  assert.equal((await requestImage(bob, `/api/content/${imagePostId}/image`)).status, 302);
  assert.equal((await call(empty, `/api/content/${imagePostId}/image`)).response.status, 404);
  await new Promise((resolve) => setTimeout(resolve, 10));
  const eventWithPartialCoordinates = await call(alice, `/api/tribes/${tribeOne.id}/events`, {
    method: "POST",
    body: JSON.stringify({
      body: "Evento inválido sem longitude.",
      title: "Evento inválido",
      startsAt: "2027-01-15T19:00:00.000Z",
      location: "Centro de Belo Horizonte",
      lat: -19.9245,
    }),
  });
  assert.equal(eventWithPartialCoordinates.response.status, 400);
  const eventResponse = await call(alice, `/api/tribes/${tribeOne.id}/events`, {
    method: "POST",
    body: JSON.stringify({
      body: "Vamos nos encontrar para jogar.",
      title: "Noite de jogos",
      startsAt: "2027-01-15T19:00:00.000Z",
      endsAt: "2027-01-15T22:00:00.000Z",
      location: "Centro de Belo Horizonte",
      lat: -19.9245,
      lon: -43.9352,
      cost: "Gratuito",
      maxAttendees: 1,
    }),
  });
  assert.equal(eventResponse.response.status, 201, JSON.stringify(eventResponse.data));
  const eventId = eventResponse.data.id;
  const editedEvent = await call(alice, `/api/content/${eventId}`, {
    method: "PATCH",
    body: JSON.stringify({
      body: "Descrição atualizada do evento.",
      event: {
        title: "Noite de jogos",
        startsAt: "2027-01-15T19:00:00.000Z",
        endsAt: "2027-01-15T22:00:00.000Z",
        location: "Centro de Belo Horizonte",
        lat: -19.91,
        lon: -43.94,
        cost: "Gratuito",
        maxAttendees: 1,
      },
    }),
  });
  assert.equal(editedEvent.response.status, 200);
  const upcomingEvents = await call(alice, "/api/events");
  assert.equal(upcomingEvents.response.status, 200);
  const listedEvent = upcomingEvents.data.events.find((event) => event.id === eventId);
  assert.ok(listedEvent && listedEvent.title === "Noite de jogos");
  assert.equal(listedEvent.lat, -19.91);
  assert.equal(listedEvent.lon, -43.94);
  assert.equal(listedEvent.maxAttendees, 1);
  assert.equal(listedEvent.waitlistCount, 0);
  assert.equal(listedEvent.waitlistedByMe, false);
  await new Promise((resolve) => setTimeout(resolve, 10));
  const postTwoId = await createPost(alice, tribeTwo, "Publicação da segunda tribo.");
  for (let index = 0; index < 23; index += 1) {
    await pool.query(
      "INSERT INTO feed_items (tribe_id, author_id, kind, body, poll_multiple) VALUES ($1, $2, 'post', $3, FALSE)",
      [tribeOne.id, alice.user.id, `Publicação paginada ${index + 1}`]
    );
    await new Promise((resolve) => setTimeout(resolve, 2));
  }

  const feed = await call(alice, "/api/feed?limit=50");
  assert.equal(feed.response.status, 200);
  assert.deepEqual(new Set(feed.data.items.map((item) => item.tribe.id)), new Set([tribeOne.id, tribeTwo.id]));
  assert.deepEqual(new Set(feed.data.items.map((item) => item.type)), new Set(["post", "event", "poll"]));
  const eventInFeed = feed.data.items.find((item) => item.id === eventId);
  assert.equal(feed.data.items.find((item) => item.id === imagePostId).imageUrl, `/api/content/${imagePostId}/image`);
  assert.equal(eventInFeed.event.title, "Noite de jogos");
  assert.equal(eventInFeed.event.location, "Centro de Belo Horizonte");
  assert.equal(eventInFeed.event.lat, -19.91);
  assert.equal(eventInFeed.event.lon, -43.94);
  for (let index = 1; index < feed.data.items.length; index += 1) {
    assert.ok(new Date(feed.data.items[index - 1].createdAt) >= new Date(feed.data.items[index].createdAt));
  }
  assert.ok(feed.data.items.findIndex((item) => item.id === postTwoId) < feed.data.items.findIndex((item) => item.id === eventId));
  assert.ok(feed.data.items.findIndex((item) => item.id === eventId) < feed.data.items.findIndex((item) => item.id === postId));

  const filtered = await call(alice, `/api/feed?tribeId=${tribeOne.id}&limit=50`);
  assert.equal(filtered.response.status, 200);
  assert.ok(filtered.data.items.length >= 2);
  assert.ok(filtered.data.items.every((item) => item.tribe.id === tribeOne.id));
  const searchedPost = await call(alice, "/api/feed?q=Publicação%20para%20todos&limit=50");
  assert.equal(searchedPost.response.status, 200);
  assert.ok(searchedPost.data.items.some((item) => item.id === postId));
  assert.ok(searchedPost.data.items.every((item) => item.body.toLowerCase().includes("publicação para todos")));
  const searchedEvent = await call(alice, "/api/feed?q=Noite%20de%20jogos&limit=50");
  assert.equal(searchedEvent.response.status, 200);
  assert.ok(searchedEvent.data.items.some((item) => item.id === eventId));
  const searchedByLocation = await call(alice, "/api/feed?q=Centro%20de%20Belo%20Horizonte&limit=50");
  assert.ok(searchedByLocation.data.items.some((item) => item.id === eventId));
  const onlyEvents = await call(alice, "/api/feed?type=event&limit=50");
  assert.equal(onlyEvents.response.status, 200);
  assert.ok(onlyEvents.data.items.length > 0);
  assert.ok(onlyEvents.data.items.every((item) => item.type === "event"));
  const filteredEvents = await call(alice, `/api/events?q=Noite%20de%20jogos&tribeId=${tribeOne.id}`);
  assert.equal(filteredEvents.response.status, 200);
  assert.ok(filteredEvents.data.events.some((item) => item.id === eventId));
  assert.equal((await call(alice, `/api/feed?q=${"x".repeat(101)}`)).response.status, 400);
  const forbidden = await call(alice, `/api/feed?tribeId=${outsiderTribe.id}`);
  assert.equal(forbidden.response.status, 403);

  const emptyFeed = await call(empty, "/api/feed");
  assert.equal(emptyFeed.response.status, 200);
  assert.deepEqual(emptyFeed.data, { items: [], nextCursor: null });

  assert.equal((await call(alice, `/api/content/${postId}/save`, { method: "POST" })).response.status, 200);
  const savedList = await call(alice, "/api/saved");
  assert.ok(savedList.data.items.some((item) => item.id === postId && item.savedByMe));
  assert.equal((await call(bob, "/api/saved")).data.items.some((item) => item.id === postId), false);
  assert.equal((await call(empty, `/api/content/${postId}/save`, { method: "POST" })).response.status, 404);
  assert.equal((await call(alice, `/api/content/${postId}/save`, { method: "DELETE" })).response.status, 200);
  assert.equal((await call(alice, "/api/saved")).data.items.some((item) => item.id === postId), false);

  const likePath = `/api/content/${eventId}/like`;
  assert.equal((await call(bob, likePath, { method: "POST" })).response.status, 200);
  assert.deepEqual((await call(bob, likePath, { method: "POST" })).data, { likesCount: 1, likedByMe: true });
  assert.deepEqual((await call(alice, likePath, { method: "POST" })).data, { likesCount: 2, likedByMe: true });
  assert.deepEqual((await call(bob, likePath, { method: "DELETE" })).data, { likesCount: 1, likedByMe: false });
  assert.equal((await call(empty, likePath, { method: "POST" })).response.status, 404);

  const attendancePath = `/api/content/${eventId}/attendance`;
  assert.deepEqual((await call(bob, attendancePath, { method: "POST" })).data, {
    attendeesCount: 1, attendingByMe: true, waitlistedByMe: false, waitlistCount: 0,
  });
  assert.deepEqual((await call(bob, attendancePath, { method: "POST" })).data, {
    attendeesCount: 1, attendingByMe: true, waitlistedByMe: false, waitlistCount: 0,
  });
  assert.deepEqual((await call(alice, attendancePath, { method: "POST" })).data, {
    attendeesCount: 1, attendingByMe: false, waitlistedByMe: true, waitlistCount: 1,
  });
  const januaryCalendarQuery = new URLSearchParams({
    from: "2027-01-01T00:00:00.000Z",
    to: "2027-02-01T00:00:00.000Z",
    attending: "true",
  });
  const bobCalendar = await call(bob, `/api/events?${januaryCalendarQuery}`);
  assert.equal(bobCalendar.response.status, 200);
  assert.deepEqual(bobCalendar.data.events.map((event) => event.id), [eventId]);
  const aliceCalendarWhileWaitlisted = await call(alice, `/api/events?${januaryCalendarQuery}`);
  assert.deepEqual(aliceCalendarWhileWaitlisted.data.events, []);
  assert.equal((await call(alice, "/api/events?from=2027-02-01T00%3A00%3A00.000Z&to=2027-01-01T00%3A00%3A00.000Z&attending=true")).response.status, 400);
  assert.deepEqual((await call(bob, attendancePath, { method: "DELETE" })).data, {
    attendeesCount: 1, attendingByMe: false, waitlistedByMe: false, waitlistCount: 0,
  });
  const promotedCalendar = await call(alice, `/api/events?${januaryCalendarQuery}`);
  assert.deepEqual(promotedCalendar.data.events.map((event) => event.id), [eventId]);
  assert.equal((await call(empty, attendancePath, { method: "POST" })).response.status, 404);
  assert.equal((await call(alice, `/api/content/${postId}/attendance`, { method: "POST" })).response.status, 404);
  const feedWithAttendance = await call(alice, `/api/feed?tribeId=${tribeOne.id}&limit=50`);
  const eventWithAttendance = feedWithAttendance.data.items.find((item) => item.id === eventId);
  assert.equal(eventWithAttendance.event.attendeesCount, 1);
  assert.equal(eventWithAttendance.event.attendingByMe, true);
  const bobFeedWithAttendance = await call(bob, `/api/feed?tribeId=${tribeOne.id}&limit=50`);
  assert.equal(bobFeedWithAttendance.data.items.find((item) => item.id === eventId).event.attendingByMe, false);
  const aliceAttendanceNotifications = await call(alice, "/api/notifications");
  assert.ok(aliceAttendanceNotifications.data.items.some((item) => item.type === "event_attendance" && item.actor.id === bob.user.id));
  assert.equal(feedWithAttendance.data.items.find((item) => item.id === postId).event, null);

  const commentsPath = `/api/content/${eventId}/comments`;
  const createdComment = await call(bob, commentsPath, { method: "POST", body: JSON.stringify({ body: "Vou participar!" }) });
  assert.equal(createdComment.response.status, 201);
  assert.equal(createdComment.data.comment.author.id, bob.user.id);
  assert.ok(createdComment.data.comment.createdAt);

  const otherComment = await call(alice, commentsPath, { method: "POST", body: JSON.stringify({ body: "Até lá!" }) });
  assert.equal(otherComment.response.status, 201);
  const firstCommentLikePath = `/api/comments/${createdComment.data.comment.id}/like`;
  const secondCommentLikePath = `/api/comments/${otherComment.data.comment.id}/like`;
  assert.deepEqual((await call(bob, firstCommentLikePath, { method: "POST" })).data, { likesCount: 1, likedByMe: true });
  assert.deepEqual((await call(bob, firstCommentLikePath, { method: "POST" })).data, { likesCount: 1, likedByMe: true });
  assert.deepEqual((await call(alice, firstCommentLikePath, { method: "POST" })).data, { likesCount: 2, likedByMe: true });
  assert.deepEqual((await call(alice, secondCommentLikePath, { method: "POST" })).data, { likesCount: 1, likedByMe: true });
  assert.equal((await call(empty, firstCommentLikePath, { method: "POST" })).response.status, 404);

  const listed = await call(alice, commentsPath);
  assert.equal(listed.data.comments.length, 2);
  assert.equal(listed.data.comments[0].body, "Vou participar!");
  assert.equal(listed.data.comments[0].likesCount, 2);
  assert.equal(listed.data.comments[0].likedByMe, true);
  assert.equal(listed.data.comments[1].likesCount, 1);
  assert.equal(listed.data.comments[1].likedByMe, true);

  assert.deepEqual((await call(alice, firstCommentLikePath, { method: "DELETE" })).data, { likesCount: 1, likedByMe: false });
  const tiedComments = await call(alice, commentsPath);
  assert.deepEqual(tiedComments.data.comments.map((comment) => comment.id), [createdComment.data.comment.id, otherComment.data.comment.id]);
  assert.deepEqual((await call(bob, firstCommentLikePath, { method: "DELETE" })).data, { likesCount: 0, likedByMe: false });
  const reorderedComments = await call(alice, commentsPath);
  assert.deepEqual(reorderedComments.data.comments.map((comment) => comment.id), [otherComment.data.comment.id, createdComment.data.comment.id]);

  const feedWithComment = await call(alice, `/api/feed?tribeId=${tribeOne.id}&limit=50`);
  assert.equal(feedWithComment.data.items.find((item) => item.id === eventId).commentsCount, 2);

  const aliceNotifications = await call(alice, "/api/notifications");
  assert.equal(aliceNotifications.response.status, 200);
  assert.ok(aliceNotifications.data.unreadCount >= 2);
  assert.ok(aliceNotifications.data.items.some((item) => item.type === "post_like" && item.actor.id === bob.user.id));
  assert.ok(aliceNotifications.data.items.some((item) => item.type === "post_comment" && item.actor.id === bob.user.id));
  const bobNotifications = await call(bob, "/api/notifications");
  assert.equal(bobNotifications.response.status, 200);
  const eventNotification = bobNotifications.data.items.find((item) => item.type === "event_created");
  assert.ok(eventNotification);
  assert.equal(eventNotification.actor.id, alice.user.id);
  assert.equal((await call(bob, `/api/notifications/${aliceNotifications.data.items[0].id}/read`, { method: "POST" })).response.status, 404);
  assert.equal((await call(alice, `/api/notifications/${aliceNotifications.data.items[0].id}/read`, { method: "POST" })).response.status, 200);
  const markedAll = await call(alice, "/api/notifications/read-all", { method: "POST" });
  assert.equal(markedAll.response.status, 200);
  assert.equal(markedAll.data.unreadCount, 0);
  assert.equal((await call(alice, "/api/notifications")).data.unreadCount, 0);
  assert.equal((await call(null, "/api/notifications")).response.status, 401);
  const unauthorizedEdit = await call(alice, `/api/comments/${createdComment.data.comment.id}`, {
    method: "PATCH", body: JSON.stringify({ body: "Tentativa de editar comentário alheio" }),
  });
  assert.equal(unauthorizedEdit.response.status, 404);
  assert.equal((await call(bob, `/api/comments/${createdComment.data.comment.id}`, {
    method: "PATCH", body: JSON.stringify({ body: "Comentário atualizado" }),
  })).response.status, 200);
  assert.equal((await call(bob, `/api/comments/${createdComment.data.comment.id}`, { method: "DELETE" })).response.status, 200);
  assert.equal((await call(alice, `/api/comments/${otherComment.data.comment.id}`, { method: "DELETE" })).response.status, 200);
  const interactedFeed = await call(alice, `/api/feed?tribeId=${tribeOne.id}&limit=50`);
  const interactedEvent = interactedFeed.data.items.find((item) => item.id === eventId);
  assert.equal(interactedEvent.likesCount, 1);
  assert.equal(interactedEvent.commentsCount, 0);

  const editablePostId = await createPost(alice, tribeOne, "Publicação editável.");
  assert.equal((await call(bob, `/api/content/${editablePostId}`, {
    method: "PATCH", body: JSON.stringify({ body: "Edição não autorizada" }),
  })).response.status, 404);
  const editedPost = await call(alice, `/api/content/${editablePostId}`, {
    method: "PATCH", body: JSON.stringify({ body: "Publicação atualizada" }),
  });
  assert.equal(editedPost.response.status, 200);
  assert.equal(editedPost.data.item.body, "Publicação atualizada");
  assert.equal((await call(bob, `/api/content/${editablePostId}`, { method: "DELETE" })).response.status, 404);
  assert.equal((await call(alice, `/api/content/${editablePostId}`, { method: "DELETE" })).response.status, 200);
  assert.ok(!(await call(alice, `/api/feed?tribeId=${tribeOne.id}&limit=50`)).data.items.some((item) => item.id === editablePostId));

  const paginatedIds = [];
  let cursor = null;
  do {
    const params = new URLSearchParams({ tribeId: tribeOne.id, limit: "10" });
    if (cursor) params.set("cursor", cursor);
    const page = await call(alice, `/api/feed?${params}`);
    assert.equal(page.response.status, 200);
    assert.ok(page.data.items.every((item) => item.tribe.id === tribeOne.id));
    paginatedIds.push(...page.data.items.map((item) => item.id));
    cursor = page.data.nextCursor;
  } while (cursor);
  assert.equal(new Set(paginatedIds).size, paginatedIds.length);
  assert.ok(paginatedIds.length >= 25);

  const left = await call(bob, `/api/tribes/${tribeOne.id}/membership`, { method: "DELETE" });
  assert.equal(left.response.status, 200);
  assert.equal((await call(bob, `/api/feed?tribeId=${tribeOne.id}`)).response.status, 403);
  assert.equal((await call(bob, `/api/content/${imagePostId}/image`)).response.status, 404);
  assert.equal((await call(bob, `/api/tribes/${tribeOne.id}/posts`, {
    method: "POST", body: JSON.stringify({ body: "Sem participação" }),
  })).response.status, 403);
  assert.equal((await call(alice, "/api/tribes?q=Games")).response.status, 200);
  assert.equal((await call(bob, "/api/auth/logout", { method: "POST" })).response.status, 200);
  assert.equal((await call(bob, "/api/auth/me")).data.user, null);
});
