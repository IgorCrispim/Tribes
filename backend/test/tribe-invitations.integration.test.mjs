import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import pg from "pg";
import { createSessionToken, digestSessionToken } from "../security.mjs";

const origin = process.env.TRIBES_TEST_ORIGIN;
const mailhog = process.env.MAILHOG_API_URL;
const integrationTest = origin && mailhog && process.env.DATABASE_URL ? test : test.skip;

function mailBody(message) {
  return (message.MIME?.Parts ?? []).map(part => {
    const body = part.Body ?? "";
    return part.Headers?.["Content-Transfer-Encoding"]?.[0]?.toLowerCase() === "base64"
      ? Buffer.from(body.replace(/\s/g, ""), "base64").toString("utf8")
      : body.replace(/=\r?\n/g, "").replace(/=([0-9a-f]{2})/gi, (_, hex) => String.fromCharCode(parseInt(hex, 16)));
  }).join("\n");
}

integrationTest("tribe invitations enforce email, ownership, status and private membership", async t => {
  const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
  const marker = `invite-${randomUUID()}`;
  const users = [];
  const tribes = [];
  async function call(actor, pathname, method = "GET", payload) {
    const response = await fetch(`${origin}${pathname}`, { method, headers: { ...(actor ? { Cookie: actor.cookie } : {}), ...(payload ? { "Content-Type": "application/json" } : {}) }, ...(payload ? { body: JSON.stringify(payload) } : {}) });
    return { response, data: await response.json() };
  }
  async function actor(label) {
    const email = `${marker}-${label}@example.test`;
    const { rows } = await pool.query("INSERT INTO users (display_name, email, password_hash) VALUES ($1, $2, $3) RETURNING id", [`Test ${label}`, email, "test-only"]);
    users.push(rows[0].id);
    const token = createSessionToken();
    await pool.query("INSERT INTO user_sessions (token_hash, user_id, expires_at) VALUES ($1, $2, CURRENT_TIMESTAMP + INTERVAL '1 day')", [digestSessionToken(token), rows[0].id]);
    return { id: rows[0].id, email, cookie: `tribes_session=${token}` };
  }
  async function waitForLink(email, pattern) {
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const response = await fetch(`${mailhog}/api/v2/search?kind=to&query=${encodeURIComponent(email)}`);
      const messages = await response.json();
      for (const message of messages.items ?? []) {
        const body = mailBody(message);
        const match = body.match(pattern);
        if (match) return { url: match[0], body };
      }
      await new Promise(resolve => setTimeout(resolve, 150));
    }
    assert.fail("E-mail esperado não chegou ao MailHog.");
  }
  t.after(async () => {
    if (tribes.length) await pool.query("DELETE FROM tribes WHERE id = ANY($1::uuid[])", [tribes]);
    if (users.length) await pool.query("DELETE FROM users WHERE id = ANY($1::uuid[])", [users]);
    await pool.query("DELETE FROM registration_tokens WHERE email LIKE $1", [`${marker}%`]);
    await pool.query("DELETE FROM email_queue WHERE email LIKE $1", [`${marker}%`]);
    await pool.end();
  });
  const owner = await actor("owner");
  const invited = await actor("invited");
  const other = await actor("other");
  const declining = await actor("declining");
  const expired = await actor("expired");
  const cancelled = await actor("cancelled");
  const expiresDuringWait = await actor("expires-during-wait");
  const created = await call(owner, "/api/tribes", "POST", { name: `${marker} tribe`, description: "Tribo para testes de convite.", category: "Games", format: "Online", city: "Belo Horizonte", isPrivate: true, password: "senha-secreta", passwordConfirmation: "senha-secreta" });
  assert.equal(created.response.status, 201, JSON.stringify(created.data));
  const tribeId = created.data.tribe.id; tribes.push(tribeId);
  const invitePath = `/api/tribes/${tribeId}/invitations`;
  const invite = email => call(owner, invitePath, "POST", { email });
  assert.equal((await call(other, invitePath, "POST", { email: invited.email })).response.status, 404);
  const duplicateRace = await Promise.all([invite(invited.email), invite(invited.email)]);
  assert.deepEqual(duplicateRace.map(result => result.response.status).sort(), [202, 409]);
  assert.equal((await invite(invited.email)).response.status, 409);
  let pending = (await call(invited, "/api/invitations")).data.invitations;
  const firstId = pending[0].id;
  const notices = (await call(invited, "/api/notifications")).data.items;
  assert.ok(notices.some(n => n.type === "tribe_invitation" && n.tribeId === tribeId && n.actor.id === owner.id));
  assert.equal((await call(other, `/api/invitations/${firstId}/accept`, "POST")).response.status, 404);
  assert.equal((await call(invited, `/api/tribes/${tribeId}/join`, "POST")).response.status, 403);
  const acceptanceRace = await Promise.all([call(invited, `/api/invitations/${firstId}/accept`, "POST"), call(invited, `/api/invitations/${firstId}/accept`, "POST")]);
  assert.deepEqual(acceptanceRace.map(result => result.response.status).sort(), [200, 404]);
  assert.equal((await call(invited, `/api/invitations/${firstId}/accept`, "POST")).response.status, 404);
  assert.equal((await pool.query("SELECT 1 FROM tribe_memberships WHERE tribe_id = $1 AND user_id = $2 AND status = 'active'", [tribeId, invited.id])).rowCount, 1);
  assert.equal((await invite(invited.email)).response.status, 409);
  assert.equal((await call(other, `/api/tribes/${tribeId}/join`, "POST")).response.status, 403);
  assert.equal((await call(invited, invitePath, "POST", { email: other.email })).response.status, 404);

  for (const [person, action] of [[declining, "decline"], [expired, "expire"], [cancelled, "cancel"]]) {
    assert.equal((await invite(person.email)).response.status, 202);
    pending = (await call(person, "/api/invitations")).data.invitations;
    const id = pending[0].id;
    assert.equal((await call(invited, `/api/invitations/${id}`, "DELETE")).response.status, 404);
    if (action === "decline") assert.equal((await call(person, `/api/invitations/${id}/decline`, "POST")).response.status, 200);
    if (action === "expire") await pool.query("UPDATE tribe_invitations SET expires_at = CURRENT_TIMESTAMP - INTERVAL '1 second' WHERE id = $1", [id]);
    if (action === "cancel") {
      assert.equal((await call(other, `/api/invitations/${id}`, "DELETE")).response.status, 404);
      assert.equal((await call(owner, `/api/invitations/${id}`, "DELETE")).response.status, 200);
    }
    assert.equal((await call(person, `/api/invitations/${id}/accept`, "POST")).response.status, 404);
  }

  assert.equal((await invite(expiresDuringWait.email)).response.status, 202);
  const waitingId = (await call(expiresDuringWait, "/api/invitations")).data.invitations[0].id;
  await pool.query("UPDATE tribe_invitations SET expires_at = clock_timestamp() + INTERVAL '2 seconds' WHERE id = $1", [waitingId]);
  const lock = await pool.connect();
  try {
    await lock.query("BEGIN");
    await lock.query("SELECT id FROM tribes WHERE id = $1 FOR UPDATE", [tribeId]);
    const blockedAcceptance = call(expiresDuringWait, `/api/invitations/${waitingId}/accept`, "POST");
    let waiting = false;
    for (let attempt = 0; attempt < 20 && !waiting; attempt += 1) {
      const state = await pool.query("SELECT 1 FROM pg_stat_activity WHERE wait_event_type = 'Lock' AND query = 'SELECT moderator_id FROM tribes WHERE id = $1 FOR UPDATE'");
      waiting = state.rowCount > 0;
      if (!waiting) await new Promise(resolve => setTimeout(resolve, 50));
    }
    assert.equal(waiting, true, "a aceitação deve aguardar o bloqueio antes do vencimento");
    await new Promise(resolve => setTimeout(resolve, 2200));
    await lock.query("COMMIT");
    assert.equal((await blockedAcceptance).response.status, 404);
  } finally { await lock.query("ROLLBACK"); lock.release(); }

  const newEmail = `${marker}-new@example.test`;
  assert.equal((await invite(newEmail)).response.status, 202);
  const invitationEmail = await waitForLink(newEmail, /https?:\/\/[^\s<"]+\/convite#token=[^\s<"]+/);
  assert.match(invitationEmail.body, /Test owner/);
  assert.ok(invitationEmail.body.includes(`${marker} tribe`));
  const invitationToken = new URLSearchParams(new URL(invitationEmail.url).hash.slice(1)).get("token");
  const saved = await pool.query("SELECT id, token_hash FROM tribe_invitations WHERE email = $1 AND tribe_id = $2", [newEmail, tribeId]);
  assert.equal(saved.rows[0].token_hash, digestSessionToken(invitationToken));
  assert.notEqual(saved.rows[0].token_hash, invitationToken);
  assert.equal((await call(other, "/api/invitations/resolve", "POST", { token: invitationToken })).response.status, 404);
  assert.equal((await call(null, "/api/auth/register", "POST", { email: newEmail, invitationToken })).response.status, 202);
  const registrationEmail = await waitForLink(newEmail, /https?:\/\/[^\s<"]+\/cadastro\/confirmar\?token=[^\s<"]+/);
  const registrationToken = new URL(registrationEmail.url).searchParams.get("token");
  const registration = await call(null, "/api/auth/register/complete", "POST", { token: registrationToken, name: "Novo Convidado", password: "Integration-test-password" });
  assert.equal(registration.response.status, 201, JSON.stringify(registration.data));
  assert.equal(registration.data.invitationTribeId, tribeId);
  users.push(registration.data.user.id);
  const newcomer = { id: registration.data.user.id, cookie: registration.response.headers.get("set-cookie").split(";")[0] };
  assert.equal((await pool.query("SELECT 1 FROM tribe_memberships WHERE tribe_id = $1 AND user_id = $2", [tribeId, newcomer.id])).rowCount, 0);
  assert.equal((await call(newcomer, "/api/invitations/resolve", "POST", { token: invitationToken })).data.tribeId, tribeId);
  assert.equal((await call(newcomer, `/api/invitations/${saved.rows[0].id}/accept`, "POST")).response.status, 200);
  assert.equal((await pool.query("SELECT 1 FROM tribe_memberships WHERE tribe_id = $1 AND user_id = $2 AND status = 'active'", [tribeId, newcomer.id])).rowCount, 1);

  let count = Number((await pool.query("SELECT COUNT(*) FROM tribe_invitations WHERE inviter_id = $1", [owner.id])).rows[0].count);
  while (count < 20) { const person = await actor(`limit-${count}`); assert.equal((await invite(person.email)).response.status, 202); count += 1; }
  const overLimit = await actor("over-limit");
  assert.equal((await invite(overLimit.email)).response.status, 429);

  assert.equal((await call(owner, `/api/tribes/${tribeId}/membership`, "DELETE")).response.status, 200);
  assert.equal((await pool.query("SELECT moderator_id FROM tribes WHERE id = $1", [tribeId])).rows[0].moderator_id, invited.id);
  assert.equal((await invite(overLimit.email)).response.status, 404);
  assert.equal((await call(invited, invitePath, "POST", { email: overLimit.email })).response.status, 202);
  const successorInvites = (await call(invited, invitePath)).data.invitations;
  const successorInvite = successorInvites.find(item => item.email === overLimit.email);
  assert.ok(successorInvite);
  assert.equal((await call(owner, `/api/invitations/${successorInvite.id}`, "DELETE")).response.status, 404);
  assert.equal((await call(invited, `/api/invitations/${successorInvite.id}`, "DELETE")).response.status, 200);
});
