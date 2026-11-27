import test from "node:test";
import assert from "node:assert/strict";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import pg from "pg";
import { createPartnerStore } from "../partner-store.mjs";
import { createSessionToken, digestSessionToken, hashPassword } from "../security.mjs";

const databaseUrl = process.env.TRIBES_PARTNER_TEST_DATABASE_URL;
const origin = process.env.TRIBES_TEST_ORIGIN;
const integrationTest = databaseUrl && origin ? test : test.skip;
const expiry = () => new Date(Date.now() + 86400000).toISOString();
const claimToken = () => randomBytes(32).toString("base64url");

integrationTest("partner event participants require explicit, private-rule-aware consent and preserve audit privacy", async t => {
  assert.equal(new URL(databaseUrl).pathname, "/tribes_partner_test", "Use exclusivamente o banco isolado tribes_partner_test.");
  const pool = new pg.Pool({ connectionString: databaseUrl, max: 24 });
  const store = createPartnerStore(pool);
  const marker = randomUUID();
  const users = [];
  const socialTribes = [];
  let partner;
  let application;
  let appIds = [];
  const participantIds = [];
  let testClaimTokenHashes = [];
  let eventId;

  async function createUser(label) {
    const row = (await pool.query(
      "INSERT INTO users (display_name, email, password_hash) VALUES ($1, $2, 'test-only') RETURNING id",
      [label, `${label.toLowerCase()}-${marker}@example.test`])).rows[0];
    const token = createSessionToken();
    await pool.query(
      "INSERT INTO user_sessions (token_hash, user_id, expires_at) VALUES ($1, $2, clock_timestamp() + INTERVAL '1 day')",
      [digestSessionToken(token), row.id]);
    const user = { id: row.id, cookie: `tribes_session=${token}` };
    users.push(user);
    return user;
  }

  async function socialCall(path, { method = "GET", cookie, body } = {}) {
    const response = await fetch(`${origin}${path}`, {
      method,
      headers: { ...(cookie ? { Cookie: cookie } : {}), ...(body === undefined ? {} : { "Content-Type": "application/json" }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    return { response, data: await response.json() };
  }

  async function partnerCall(path, { method = "GET", body, key } = {}) {
    const response = await fetch(`${origin}/api/v1/partners${path}`, {
      method,
      headers: { Authorization: `Bearer ${key ?? fullKey.apiKey}`, ...(body === undefined ? {} : { "Content-Type": "application/json" }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    return { response, data: await response.json() };
  }

  t.after(async () => {
    if (partner) {
      await pool.query("DELETE FROM partner_event_participant_audit_aggregates WHERE partner_id = $1", [partner.id]);
      if (testClaimTokenHashes.length) {
        await pool.query("DELETE FROM partner_event_participant_claim_token_hashes WHERE token_hash = ANY($1::char(64)[])", [testClaimTokenHashes]);
      }
      await pool.query("DELETE FROM partner_event_participant_previews WHERE participant_id IN (SELECT id FROM partner_event_participants WHERE partner_id = $1)", [partner.id]);
      await pool.query("DELETE FROM partner_event_participant_history WHERE partner_id = $1", [partner.id]);
      await pool.query("DELETE FROM partner_event_participants WHERE partner_id = $1", [partner.id]);
    }
    if (socialTribes.length) await pool.query("DELETE FROM tribes WHERE id = ANY($1::uuid[])", [socialTribes]);
    if (partner) {
      await pool.query("DELETE FROM partner_social_link_previews WHERE partner_id = $1", [partner.id]);
      await pool.query("DELETE FROM partner_social_tribe_link_history WHERE partner_id = $1", [partner.id]);
      await pool.query("DELETE FROM partner_audit_logs WHERE partner_id = $1", [partner.id]);
      await pool.query("DELETE FROM partner_events WHERE partner_id = $1", [partner.id]);
      await pool.query("DELETE FROM partner_tribes WHERE partner_id = $1", [partner.id]);
      await pool.query("DELETE FROM partner_api_keys WHERE partner_id = $1", [partner.id]);
      await pool.query("DELETE FROM partner_rate_limits WHERE application_id = ANY($1::uuid[])", [appIds]);
      await pool.query("DELETE FROM partner_applications WHERE partner_id = $1", [partner.id]);
      await pool.query("DELETE FROM partners WHERE id = $1", [partner.id]);
    }
    if (users.length) {
      await pool.query("DELETE FROM user_sessions WHERE user_id = ANY($1::uuid[])", [users.map(user => user.id)]);
      await pool.query("DELETE FROM tribe_memberships WHERE user_id = ANY($1::uuid[])", [users.map(user => user.id)]);
      await pool.query("DELETE FROM tribes WHERE created_by = ANY($1::uuid[])", [users.map(user => user.id)]);
      await pool.query("DELETE FROM users WHERE id = ANY($1::uuid[])", [users.map(user => user.id)]);
    }
    await pool.end();
  });

  const moderator = await createUser("Participant moderator");
  const claimant = await createUser("Participant claimant");
  const otherUser = await createUser("Participant other");
  const lateUser = await createUser("Participant late");
  const privatePassword = "Community-password-44!";
  const passwordHash = await hashPassword(privatePassword);
  const socialTribe = (await pool.query(
    `INSERT INTO tribes (name, description, category, format, city, created_by, moderator_id, is_private, password_hash)
     VALUES ($1, 'Private participant test tribe.', 'Games', 'Online', 'Belo Horizonte', $2, $2, TRUE, $3) RETURNING id`,
    [`Participant private tribe ${marker}`, moderator.id, passwordHash])).rows[0];
  socialTribes.push(socialTribe.id);
  await pool.query("INSERT INTO tribe_memberships (tribe_id, user_id) VALUES ($1, $2)", [socialTribe.id, moderator.id]);

  partner = await store.createPartner({ slug: `part-${marker.slice(0, 8)}`, name: "Participant integration partner" });
  const scopes = ["events:read", "events:write", "organizers:write", "participants:write"];
  application = await store.createApplication({ partnerId: partner.id, slug: "ticketing", name: "Ticketing integration", scopes });
  appIds.push(application.id);
  const fullKey = await store.issueKey({ applicationId: application.id, label: "Participants full", scopes, expiresAt: expiry() });
  const participantOnlyKey = await store.issueKey({ applicationId: application.id, label: "Participants only", scopes: ["participants:write"], expiresAt: expiry() });
  const clubId = `club-${marker.slice(0, 12)}`;
  const eventExternalId = `event-${marker.slice(0, 12)}`;
  const club = await partnerCall("/tribes", { method: "POST", body: {
    externalTribeId: clubId, name: "Partner club", description: "Partner provisional social club.",
    category: "Games", format: "Online", city: "Belo Horizonte",
  } });
  assert.equal(club.response.status, 201, JSON.stringify(club.data));
  const event = await partnerCall("/events", { method: "POST", body: {
    externalEventId: eventExternalId, externalTribeId: clubId, title: "Partner game night", description: "Ticketed social event.",
    startsAt: "2040-04-05T18:00:00Z", endsAt: "2040-04-05T21:00:00Z", location: "Community hall", maxAttendees: 25,
  } });
  assert.equal(event.response.status, 201, JSON.stringify(event.data));
  eventId = event.data.event.id;

  const previewLink = await socialCall(`/api/tribes/${socialTribe.id}/partner-links/preview`, {
    cookie: moderator.cookie, method: "POST", body: { applicationId: application.id, externalTribeId: clubId },
  });
  assert.equal(previewLink.response.status, 200, JSON.stringify(previewLink.data));
  assert.equal((await socialCall(`/api/tribes/${socialTribe.id}/partner-links/confirm`, {
    cookie: moderator.cookie, method: "POST", body: { confirmationToken: previewLink.data.confirmationToken, confirmPrivateSharing: true },
  })).response.status, 201);

  const participantExternalId = `ticket-${marker.slice(0, 12)}`;
  let rawSecret = claimToken();
  const registrationPath = `/events/${encodeURIComponent(eventExternalId)}/participants/${encodeURIComponent(participantExternalId)}`;
  const registered = await partnerCall(registrationPath, { method: "POST", body: { claimToken: rawSecret } });
  assert.equal(registered.response.status, 201, JSON.stringify(registered.data));
  assert.equal(registered.data.created, true);
  const participantId = registered.data.participant.id;
  participantIds.push(participantId);
  const repeatedRegistration = await partnerCall(registrationPath, { method: "POST", body: { claimToken: rawSecret } });
  assert.equal(repeatedRegistration.response.status, 200);
  assert.equal(repeatedRegistration.data.participant.id, participantId);
  assert.equal((await pool.query("SELECT count(*)::int AS count FROM partner_event_participants WHERE id = $1", [participantId])).rows[0].count, 1);
  assert.equal((await pool.query("SELECT claim_token_hash FROM partner_event_participants WHERE id = $1", [participantId])).rows[0].claim_token_hash,
    createHash("sha256").update(rawSecret).digest("hex"));
  assert.equal(JSON.stringify(registered.data).includes(rawSecret), false);
  assert.equal(JSON.stringify(registered.data).includes(claimant.id), false);
  assert.equal((await partnerCall(registrationPath, { method: "POST", body: { claimToken: claimToken() } })).response.status, 409);
  const firstSecret = rawSecret;
  const reusedRotatedSecret = await partnerCall(`/events/${eventExternalId}/participants/reused-secret`, {
    method: "POST", body: { claimToken: firstSecret },
  });
  assert.equal(reusedRotatedSecret.response.status, 409, "a rotated secret remains reserved across participant records");
  rawSecret = claimToken();
  const claimTokenPath = `/events/${eventExternalId}/participants/${participantExternalId}/claim-token`;
  const tokenRotation = await partnerCall(claimTokenPath, { method: "PUT", body: { claimToken: rawSecret } });
  assert.equal(tokenRotation.response.status, 200, JSON.stringify(tokenRotation.data));
  assert.equal(tokenRotation.data.rotated, true);
  const tokenRotationRetry = await partnerCall(claimTokenPath, { method: "PUT", body: { claimToken: rawSecret } });
  assert.equal(tokenRotationRetry.response.status, 200);
  assert.equal(tokenRotationRetry.data.rotated, false);
  assert.equal(tokenRotationRetry.data.expiresAt, tokenRotation.data.expiresAt);
  assert.equal((await socialCall("/api/partner-participants/preview", {
    cookie: claimant.cookie, method: "POST", body: { claimToken: firstSecret },
  })).response.status, 404, "rotation invalidates the preceding secret");
  const secondSecret = claimToken();
  const secondExternalId = "another";
  const secondRegistration = await partnerCall(`/events/${eventExternalId}/participants/${secondExternalId}`, {
    method: "POST", body: { claimToken: secondSecret }, key: participantOnlyKey.apiKey,
  });
  assert.equal(secondRegistration.response.status, 201);
  participantIds.push(secondRegistration.data.participant.id);

  assert.equal((await socialCall("/api/partner-participants/preview", { method: "POST", body: { claimToken: rawSecret } })).response.status, 401);
  assert.equal((await pool.query("SELECT claim_token_used_at FROM partner_event_participants WHERE id = $1", [participantId])).rows[0].claim_token_used_at, null);
  const preview = await socialCall("/api/partner-participants/preview", { cookie: claimant.cookie, method: "POST", body: { claimToken: rawSecret } });
  assert.equal(preview.response.status, 200, JSON.stringify(preview.data));
  assert.equal(preview.data.socialTribe.isPrivate, true);
  assert.equal(preview.data.partner.name, "Participant integration partner");
  assert.equal(JSON.stringify(preview.data).includes(claimant.id), false);
  assert.equal((await pool.query("SELECT claim_token_used_at FROM partner_event_participants WHERE id = $1", [participantId])).rows[0].claim_token_used_at, null,
    "a preview must not consume the underlying ticket secret");
  const forgedConfirmation = await socialCall("/api/partner-participants/confirm", {
    cookie: otherUser.cookie, method: "POST", body: { confirmationToken: preview.data.confirmationToken },
  });
  assert.equal(forgedConfirmation.response.status, 409);
  const linked = await socialCall("/api/partner-participants/confirm", {
    cookie: claimant.cookie, method: "POST", body: { confirmationToken: preview.data.confirmationToken },
  });
  assert.equal(linked.response.status, 200, JSON.stringify(linked.data));
  const linkedRetry = await socialCall("/api/partner-participants/confirm", {
    cookie: claimant.cookie, method: "POST", body: { confirmationToken: preview.data.confirmationToken },
  });
  assert.equal(linkedRetry.response.status, 200, JSON.stringify(linkedRetry.data));
  assert.equal(linkedRetry.data.participant.id, participantId);
  const linkedRow = (await pool.query("SELECT claimed_user_id, claim_token_used_at FROM partner_event_participants WHERE id = $1", [participantId])).rows[0];
  assert.equal(linkedRow.claimed_user_id, claimant.id);
  assert.ok(linkedRow.claim_token_used_at);
  assert.equal((await pool.query("SELECT 1 FROM tribe_memberships WHERE tribe_id = $1 AND user_id = $2 AND status = 'active'", [socialTribe.id, claimant.id])).rowCount, 0,
    "claim confirmation must not create a social membership");
  assert.equal((await partnerCall(registrationPath, { method: "POST", body: { claimToken: rawSecret } })).response.status, 200,
    "replaying participant creation after claim remains idempotent");
  assert.equal((await partnerCall(`/events/${eventExternalId}/participants/${participantExternalId}/claim-token`, {
    method: "PUT", body: { claimToken: claimToken() },
  })).response.status, 409);

  const previewRotationSecret = claimToken();
  const previewRotationRegistration = await partnerCall(`/events/${eventExternalId}/participants/preview-rotation`, {
    method: "POST", body: { claimToken: previewRotationSecret },
  });
  assert.equal(previewRotationRegistration.response.status, 201);
  participantIds.push(previewRotationRegistration.data.participant.id);
  const oldSecretPreview = await socialCall("/api/partner-participants/preview", {
    cookie: lateUser.cookie, method: "POST", body: { claimToken: previewRotationSecret },
  });
  assert.equal(oldSecretPreview.response.status, 200);
  const replacementSecret = claimToken();
  const previewRotation = await partnerCall(`/events/${eventExternalId}/participants/preview-rotation/claim-token`, {
    method: "PUT", body: { claimToken: replacementSecret },
  });
  assert.equal(previewRotation.response.status, 200, JSON.stringify(previewRotation.data));
  assert.equal((await pool.query(
    "SELECT claim_token_version FROM partner_event_participants WHERE id = $1",
    [previewRotationRegistration.data.participant.id])).rows[0].claim_token_version, "2");
  assert.equal((await pool.query(
    "SELECT claim_token_version FROM partner_event_participant_previews WHERE participant_id = $1 AND confirmation_token_hash = $2",
    [previewRotationRegistration.data.participant.id, createHash("sha256").update(oldSecretPreview.data.confirmationToken).digest("hex")])).rows[0].claim_token_version, "1",
  "the challenge remains bound to the old version and cannot authenticate the rotated secret");
  assert.equal((await socialCall("/api/partner-participants/confirm", {
    cookie: lateUser.cookie, method: "POST", body: { confirmationToken: oldSecretPreview.data.confirmationToken },
  })).response.status, 409, "a challenge issued against an earlier secret version cannot be confirmed");
  assert.equal((await socialCall("/api/partner-participants/preview", {
    cookie: lateUser.cookie, method: "POST", body: { claimToken: previewRotationSecret },
  })).response.status, 404);
  assert.equal((await partnerCall(`/events/${eventExternalId}/participants/reused-rotated-preview-secret`, {
    method: "POST", body: { claimToken: previewRotationSecret },
  })).response.status, 409);
  const currentSecretPreview = await socialCall("/api/partner-participants/preview", {
    cookie: lateUser.cookie, method: "POST", body: { claimToken: replacementSecret },
  });
  assert.equal(currentSecretPreview.response.status, 200, JSON.stringify(currentSecretPreview.data));
  assert.equal((await socialCall("/api/partner-participants/confirm", {
    cookie: lateUser.cookie, method: "POST", body: { confirmationToken: currentSecretPreview.data.confirmationToken },
  })).response.status, 200);

  const raceSecret = claimToken();
  const raceRegistration = await partnerCall(`/events/${eventExternalId}/participants/rotation-race`, {
    method: "POST", body: { claimToken: raceSecret },
  });
  assert.equal(raceRegistration.response.status, 201);
  participantIds.push(raceRegistration.data.participant.id);
  const racePreview = await socialCall("/api/partner-participants/preview", {
    cookie: lateUser.cookie, method: "POST", body: { claimToken: raceSecret },
  });
  assert.equal(racePreview.response.status, 200);
  const raceConfirmation = socialCall("/api/partner-participants/confirm", {
    cookie: lateUser.cookie, method: "POST", body: { confirmationToken: racePreview.data.confirmationToken },
  });
  const raceRotation = partnerCall(`/events/${eventExternalId}/participants/rotation-race/claim-token`, {
    method: "PUT", body: { claimToken: claimToken() },
  });
  const [raceConfirmationResult, raceRotationResult] = await Promise.all([raceConfirmation, raceRotation]);
  assert.ok(
    (raceConfirmationResult.response.status === 200 && raceRotationResult.response.status === 409) ||
    (raceConfirmationResult.response.status === 409 && raceRotationResult.response.status === 200),
    `rotation and confirmation must serialize; got confirm=${raceConfirmationResult.response.status} ${JSON.stringify(raceConfirmationResult.data)}, rotate=${raceRotationResult.response.status} ${JSON.stringify(raceRotationResult.data)}`,
  );

  const joinPath = `/api/me/partner-participants/${participantId}/join-tribe`;
  const wrongPassword = await socialCall(joinPath, { cookie: claimant.cookie, method: "POST", body: { password: "wrong" } });
  assert.equal(wrongPassword.response.status, 403);
  assert.equal((await pool.query("SELECT 1 FROM tribe_memberships WHERE tribe_id = $1 AND user_id = $2 AND status = 'active'", [socialTribe.id, claimant.id])).rowCount, 0);
  const joined = await socialCall(joinPath, { cookie: claimant.cookie, method: "POST", body: { password: privatePassword } });
  assert.equal(joined.response.status, 200, JSON.stringify(joined.data));
  assert.equal(joined.data.joined, true);
  const joinedAgain = await socialCall(joinPath, { cookie: claimant.cookie, method: "POST", body: { password: privatePassword } });
  assert.equal(joinedAgain.response.status, 200);
  assert.equal(joinedAgain.data.joined, false);
  assert.equal((await pool.query("SELECT count(*)::int AS count FROM tribe_memberships WHERE tribe_id = $1 AND user_id = $2 AND status = 'active'", [socialTribe.id, claimant.id])).rows[0].count, 1);

  const cancelParticipant = await partnerCall(registrationPath, { method: "DELETE" });
  assert.equal(cancelParticipant.response.status, 200);
  assert.equal(cancelParticipant.data.changed, true);
  assert.equal((await partnerCall(registrationPath, { method: "DELETE" })).data.changed, false);
  assert.equal((await pool.query("SELECT 1 FROM tribe_memberships WHERE tribe_id = $1 AND user_id = $2 AND status = 'active'", [socialTribe.id, claimant.id])).rowCount, 1,
    "ticket cancellation must not remove a membership already earned by explicit entry");
  const ownParticipants = await socialCall("/api/me/partner-participants", { cookie: claimant.cookie });
  assert.equal(ownParticipants.response.status, 200);
  assert.equal(ownParticipants.data.participants.length, 1);
  assert.equal(JSON.stringify(ownParticipants.data).includes(claimant.id), false);
  assert.equal(JSON.stringify(ownParticipants.data).includes("@example.test"), false);

  const movedClubId = `${clubId}-other`;
  const secondClub = await partnerCall("/tribes", { method: "POST", body: {
    externalTribeId: movedClubId, name: "Other partner club", description: "Another provisional community.",
    category: "Games", format: "Online", city: "Belo Horizonte",
  } });
  assert.equal(secondClub.response.status, 201);
  const move = await partnerCall(`/events/${encodeURIComponent(eventExternalId)}`, { method: "PATCH", body: {
    externalTribeId: movedClubId, title: "Partner game night", description: "Ticketed social event.",
    startsAt: "2040-04-05T18:00:00Z", endsAt: "2040-04-05T21:00:00Z", location: "Community hall", cost: "", maxAttendees: 25,
  } });
  assert.equal(move.response.status, 409);
  assert.equal(move.data.code, "event_has_participants");

  const forbiddenCancel = await partnerCall(`/events/${encodeURIComponent(eventExternalId)}/cancel`, {
    method: "POST", key: participantOnlyKey.apiKey,
  });
  assert.equal(forbiddenCancel.response.status, 403);

  const secondClaimPreview = await socialCall("/api/partner-participants/preview", {
    cookie: otherUser.cookie, method: "POST", body: { claimToken: secondSecret },
  });
  assert.equal(secondClaimPreview.response.status, 200, JSON.stringify(secondClaimPreview.data));
  assert.equal((await socialCall("/api/partner-participants/confirm", {
    cookie: otherUser.cookie, method: "POST", body: { confirmationToken: secondClaimPreview.data.confirmationToken },
  })).response.status, 200);

  const lateSecret = claimToken();
  const lateRegistration = await partnerCall(`/events/${eventExternalId}/participants/late`, {
    method: "POST", body: { claimToken: lateSecret },
  });
  assert.equal(lateRegistration.response.status, 201);
  participantIds.push(lateRegistration.data.participant.id);
  const lateClaimPreview = await socialCall("/api/partner-participants/preview", {
    cookie: lateUser.cookie, method: "POST", body: { claimToken: lateSecret },
  });
  assert.equal(lateClaimPreview.response.status, 200);
  assert.equal((await socialCall("/api/partner-participants/confirm", {
    cookie: lateUser.cookie, method: "POST", body: { confirmationToken: lateClaimPreview.data.confirmationToken },
  })).response.status, 200);

  const expiredSecret = claimToken();
  const expiredRegistration = await partnerCall(`/events/${eventExternalId}/participants/expired`, {
    method: "POST", body: { claimToken: expiredSecret },
  });
  assert.equal(expiredRegistration.response.status, 201);
  participantIds.push(expiredRegistration.data.participant.id);
  await pool.query("UPDATE partner_event_participants SET claim_expires_at = clock_timestamp() - INTERVAL '1 second' WHERE id = $1", [expiredRegistration.data.participant.id]);
  assert.equal((await socialCall("/api/partner-participants/preview", {
    cookie: lateUser.cookie, method: "POST", body: { claimToken: expiredSecret },
  })).response.status, 404);

  const raceJoin = socialCall(`/api/me/partner-participants/${secondRegistration.data.participant.id}/join-tribe`, {
    cookie: otherUser.cookie, method: "POST", body: { password: privatePassword },
  });
  const raceCancel = partnerCall(`/events/${encodeURIComponent(eventExternalId)}/cancel`, { method: "POST" });
  const [raceJoinResult, eventCancel] = await Promise.all([raceJoin, raceCancel]);
  assert.equal(eventCancel.response.status, 200, JSON.stringify(eventCancel.data));
  assert.equal(eventCancel.data.changed, true);
  assert.ok([200, 409].includes(raceJoinResult.response.status), JSON.stringify(raceJoinResult.data));
  if (raceJoinResult.response.status === 200) assert.equal(raceJoinResult.data.joined, true);
  assert.equal((await socialCall(`/api/me/partner-participants/${lateRegistration.data.participant.id}/join-tribe`, {
    cookie: lateUser.cookie, method: "POST", body: { password: privatePassword },
  })).response.status, 409, "an event cancellation wins against any later first-time tribe entry");

  assert.equal((await partnerCall(`/events/${encodeURIComponent(eventExternalId)}/cancel`, { method: "POST" })).data.changed, false);
  const eventAfterCancel = await partnerCall(`/events/${encodeURIComponent(eventExternalId)}`);
  assert.equal(eventAfterCancel.data.event.status, "cancelled");
  assert.ok(eventAfterCancel.data.event.cancelledAt);
  assert.equal((await partnerCall(`/events/${eventExternalId}/participants/after-cancel`, { method: "POST", body: { claimToken: claimToken() } })).response.status, 409);
  assert.equal((await socialCall(joinPath, { cookie: otherUser.cookie, method: "POST", body: { password: privatePassword } })).response.status, 404);
  assert.equal((await pool.query("SELECT 1 FROM tribe_memberships WHERE tribe_id = $1 AND user_id = $2 AND status = 'active'", [socialTribe.id, claimant.id])).rowCount, 1);

  const unlink = await socialCall(`/api/me/partner-participants/${participantId}`, { cookie: claimant.cookie, method: "DELETE" });
  assert.equal(unlink.response.status, 200, JSON.stringify(unlink.data));
  assert.equal(unlink.data.unlinked, true);
  assert.equal((await socialCall(`/api/me/partner-participants/${participantId}`, { cookie: claimant.cookie, method: "DELETE" })).data.unlinked, false);
  assert.equal((await socialCall("/api/partner-participants/confirm", {
    cookie: claimant.cookie, method: "POST", body: { confirmationToken: preview.data.confirmationToken },
  })).response.status, 200, "the same user's retry remains idempotent after a later unlink");
  assert.equal((await pool.query("SELECT claimed_user_id FROM partner_event_participants WHERE id = $1", [participantId])).rows[0].claimed_user_id, null,
    "an idempotent confirmation retry must not undo an explicit unlink");
  assert.equal((await pool.query("SELECT 1 FROM tribe_memberships WHERE tribe_id = $1 AND user_id = $2 AND status = 'active'", [socialTribe.id, claimant.id])).rowCount, 1);

  const participantCount = (await pool.query("SELECT count(*)::int AS count FROM partner_event_participants WHERE partner_event_id = $1", [eventId])).rows[0].count;
  assert.equal(participantCount, 6);
  const historicalHashCount = (await pool.query(
    "SELECT count(*)::int AS count FROM partner_event_participant_claim_token_hashes WHERE participant_id = ANY($1::uuid[])",
    [participantIds])).rows[0].count;
  assert.ok(historicalHashCount >= participantCount, "current and rotated secret hashes are retained as tombstones");
  testClaimTokenHashes = (await pool.query(
    "SELECT token_hash FROM partner_event_participant_claim_token_hashes WHERE participant_id = ANY($1::uuid[])",
    [participantIds])).rows.map(row => row.token_hash);
});
