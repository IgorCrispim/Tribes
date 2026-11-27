import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import pg from "pg";
import { createPartnerStore } from "../partner-store.mjs";
import { createSessionToken, digestSessionToken } from "../security.mjs";

const databaseUrl = process.env.TRIBES_PARTNER_TEST_DATABASE_URL;
const origin = process.env.TRIBES_TEST_ORIGIN;
const integrationTest = databaseUrl && origin ? test : test.skip;
const expiry = () => new Date(Date.now() + 86400000).toISOString();

integrationTest("social moderator consent previews, authorizes, revokes and protects partner tribe metadata", async t => {
  assert.equal(new URL(databaseUrl).pathname, "/tribes_partner_test", "Use exclusivamente o banco isolado tribes_partner_test.");
  const pool = new pg.Pool({ connectionString: databaseUrl, max: 20 });
  const store = createPartnerStore(pool);
  const marker = randomUUID();
  const partner = await store.createPartner({ slug: `link-${marker.slice(0, 8)}`, name: "Link test partner" });
  const scopes = ["events:read", "events:write", "organizers:write"];
  const app = await store.createApplication({ partnerId: partner.id, slug: "main", name: "Main integration", scopes });
  const otherApp = await store.createApplication({ partnerId: partner.id, slug: "other", name: "Other integration", scopes });
  const credential = await store.issueKey({ applicationId: app.id, label: "Link test key", expiresAt: expiry() });
  const otherCredential = await store.issueKey({ applicationId: otherApp.id, label: "Other app key", expiresAt: expiry() });
  let moderator;
  let member;
  let outsider;
  let privateTribe;
  let deleteTribe;

  async function createUser(label) {
    const email = `${label}-${marker}@example.test`;
    const row = (await pool.query(
      "INSERT INTO users (display_name, email, password_hash) VALUES ($1, $2, 'test-only') RETURNING id",
      [label, email])).rows[0];
    const token = createSessionToken();
    await pool.query(
      "INSERT INTO user_sessions (token_hash, user_id, expires_at) VALUES ($1, $2, clock_timestamp() + INTERVAL '1 day')",
      [digestSessionToken(token), row.id]);
    return { id: row.id, cookie: `tribes_session=${token}` };
  }

  async function createSocialTribe(owner, name, isPrivate = false) {
    const row = (await pool.query(
      `INSERT INTO tribes (name, description, category, format, city, created_by, moderator_id, is_private, password_hash)
       VALUES ($1, $2, 'Games', 'Online', 'Belo Horizonte', $3, $3, $4, $5) RETURNING id`,
      [name, `Private details ${marker}`, owner.id, isPrivate, isPrivate ? "hash-placeholder" : null])).rows[0];
    await pool.query("INSERT INTO tribe_memberships (tribe_id, user_id) VALUES ($1, $2)", [row.id, owner.id]);
    return row.id;
  }

  async function socialCall(path, { method = "GET", cookie, body } = {}) {
    const response = await fetch(`${origin}${path}`, {
      method,
      headers: { ...(cookie ? { Cookie: cookie } : {}), ...(body === undefined ? {} : { "Content-Type": "application/json" }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    return { response, data: await response.json() };
  }

  async function partnerCall(path, { method = "GET", body, apiKey = credential.apiKey } = {}) {
    const response = await fetch(`${origin}/api/v1/partners${path}`, {
      method,
      headers: { Authorization: `Bearer ${apiKey}`, ...(body === undefined ? {} : { "Content-Type": "application/json" }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    return { response, data: await response.json() };
  }

  t.after(async () => {
    const partnerIds = [partner.id];
    await pool.query("DELETE FROM partner_social_link_previews WHERE partner_id = ANY($1::uuid[])", [partnerIds]);
    await pool.query("DELETE FROM partner_social_tribe_link_history WHERE partner_id = ANY($1::uuid[])", [partnerIds]);
    await pool.query("DELETE FROM partner_audit_logs WHERE partner_id = ANY($1::uuid[])", [partnerIds]);
    await pool.query("DELETE FROM partner_events WHERE partner_id = ANY($1::uuid[])", [partnerIds]);
    await pool.query("DELETE FROM partner_tribes WHERE partner_id = ANY($1::uuid[])", [partnerIds]);
    await pool.query("DELETE FROM partner_api_keys WHERE partner_id = ANY($1::uuid[])", [partnerIds]);
    await pool.query("DELETE FROM partner_rate_limits WHERE application_id IN (SELECT id FROM partner_applications WHERE partner_id = ANY($1::uuid[]))", [partnerIds]);
    await pool.query("DELETE FROM partner_applications WHERE partner_id = ANY($1::uuid[])", [partnerIds]);
    await pool.query("DELETE FROM partners WHERE id = ANY($1::uuid[])", [partnerIds]);
    const userIds = [moderator?.id, member?.id, outsider?.id].filter(Boolean);
    if (userIds.length) {
      await pool.query("DELETE FROM user_sessions WHERE user_id = ANY($1::uuid[])", [userIds]);
      await pool.query("DELETE FROM tribe_memberships WHERE user_id = ANY($1::uuid[])", [userIds]);
    }
    const tribeIds = [privateTribe, deleteTribe].filter(Boolean);
    if (tribeIds.length) await pool.query("DELETE FROM tribes WHERE id = ANY($1::uuid[])", [tribeIds]);
    if (userIds.length) {
      await pool.query("DELETE FROM tribes WHERE created_by = ANY($1::uuid[])", [userIds]);
      await pool.query("DELETE FROM users WHERE id = ANY($1::uuid[])", [userIds]);
    }
    await pool.end();
  });

  moderator = await createUser("Moderator");
  member = await createUser("Member");
  outsider = await createUser("Other moderator");
  privateTribe = await createSocialTribe(moderator, `Secret tribe ${marker}`, true);
  deleteTribe = await createSocialTribe(moderator, `Delete linked tribe ${marker}`);
  const outsiderTribe = await createSocialTribe(outsider, `Other tribe ${marker}`);
  await pool.query(
    "INSERT INTO tribe_memberships (tribe_id, user_id) VALUES ($1, $2)", [privateTribe, member.id]);

  const externalTribeId = `social-${marker.slice(0, 12)}`;
  const externalEventId = `event-${marker.slice(0, 12)}`;
  const eventPayload = {
    externalEventId, externalTribeId, title: "Partner event", description: "Partner event details.",
    startsAt: "2032-04-05T18:00:00Z", location: "Partner location",
  };
  const partnerTribe = await partnerCall("/tribes", { method: "POST", body: {
    externalTribeId, name: "Partner-owned club", description: "Partner supplied metadata.",
    category: "Games", format: "Online", city: "Partner city",
  } });
  assert.equal(partnerTribe.response.status, 201);
  const partnerEvent = await partnerCall("/events", { method: "POST", body: eventPayload });
  assert.equal(partnerEvent.response.status, 201);
  const otherAppTribe = await partnerCall("/tribes", { method: "POST", apiKey: otherCredential.apiKey, body: {
    externalTribeId, name: "Other app club", description: "Metadata owned by the other app.",
    category: "Games", format: "Online", city: "Other city",
  } });
  assert.equal(otherAppTribe.response.status, 201);
  assert.equal((await partnerCall(`/events/${encodeURIComponent(externalEventId)}`, { apiKey: otherCredential.apiKey })).response.status, 404);

  const privateName = `Secret tribe ${marker}`;
  const privateDescription = `Private details ${marker}`;
  const beforeTribe = await partnerCall(`/tribes/${encodeURIComponent(externalTribeId)}`);
  const beforeEvent = await partnerCall(`/events/${encodeURIComponent(externalEventId)}`);
  assert.equal(beforeTribe.response.status, 200);
  assert.equal(beforeEvent.response.status, 200);
  assert.equal(JSON.stringify(beforeTribe.data).includes(privateName), false);
  assert.equal(JSON.stringify(beforeTribe.data).includes(privateDescription), false);
  assert.equal(JSON.stringify(beforeEvent.data).includes(privateName), false);
  assert.equal((await pool.query("SELECT count(*)::int AS count FROM partner_social_tribe_link_history WHERE partner_tribe_id = $1", [partnerTribe.data.tribe.id])).rows[0].count, 0);

  const linksPath = `/api/tribes/${privateTribe}/partner-links`;
  const oversizedLinkPreview = await socialCall(`${linksPath}/preview`, {
    cookie: moderator.cookie,
    method: "POST",
    body: { applicationId: app.id, externalTribeId, padding: "x".repeat(70 * 1024) },
  });
  assert.equal(oversizedLinkPreview.response.status, 413);
  assert.equal(oversizedLinkPreview.data.code, "invalid_payload");

  const oversizedGrant = await socialCall(`/api/tribes/${privateTribe}/partner-grants`, {
    cookie: moderator.cookie,
    method: "POST",
    body: { applicationId: app.id, externalTribeId, beneficiaryUserId: moderator.id, padding: "x".repeat(4096) },
  });
  assert.equal(oversizedGrant.response.status, 413);
  assert.equal(oversizedGrant.data.code, "invalid_payload");

  const anonymousPrivateDetail = await socialCall(`/api/tribes/${privateTribe}`);
  assert.equal(anonymousPrivateDetail.response.status, 404);
  assert.equal(JSON.stringify(anonymousPrivateDetail.data).includes(privateName), false);
  const outsiderPrivateDetail = await socialCall(`/api/tribes/${privateTribe}`, { cookie: outsider.cookie });
  assert.equal(outsiderPrivateDetail.response.status, 404);
  assert.equal(JSON.stringify(outsiderPrivateDetail.data).includes(privateName), false);
  const memberPrivateDetail = await socialCall(`/api/tribes/${privateTribe}`, { cookie: member.cookie });
  assert.equal(memberPrivateDetail.response.status, 200);
  assert.equal(memberPrivateDetail.data.tribe.name, privateName);
  assert.equal((await socialCall(linksPath, { cookie: member.cookie })).response.status, 404);
  assert.equal((await socialCall(linksPath, { cookie: outsider.cookie })).response.status, 404);
  assert.equal((await socialCall(linksPath)).response.status, 401);
  assert.equal((await socialCall(linksPath, { cookie: moderator.cookie, method: "POST", body: {
    applicationId: app.id, externalTribeId, approvedBy: moderator.id,
  } })).response.status, 405);
  assert.equal((await socialCall(`/api/tribes/${privateTribe}/partner-links/preview`, { cookie: moderator.cookie, method: "POST", body: {
    applicationId: app.id, externalTribeId, approvedBy: moderator.id,
  } })).response.status, 400);
  assert.equal((await socialCall(`/api/tribes/${privateTribe}/partner-links/preview`, { cookie: moderator.cookie, method: "POST", body: {
    applicationId: app.id, externalTribeId, userId: outsider.id,
  } })).response.status, 400);
  assert.equal((await socialCall(`/api/tribes/${privateTribe}/partner-links/preview`, { cookie: member.cookie, method: "POST", body: {
    applicationId: app.id, externalTribeId,
  } })).response.status, 404);
  assert.equal((await socialCall(`/api/tribes/${privateTribe}/partner-links/preview`, { cookie: outsider.cookie, method: "POST", body: {
    applicationId: app.id, externalTribeId,
  } })).response.status, 404);
  assert.equal((await socialCall(`/api/tribes/${outsiderTribe}/partner-links/preview`, { cookie: moderator.cookie, method: "POST", body: {
    applicationId: app.id, externalTribeId,
  } })).response.status, 404);
  const partnerKeyToSocialRoute = await fetch(`${origin}${linksPath}`, {
    headers: { Authorization: `Bearer ${credential.apiKey}` },
  });
  assert.equal(partnerKeyToSocialRoute.status, 401);

  const preview = await socialCall(`${linksPath}/preview`, { cookie: moderator.cookie, method: "POST", body: {
    applicationId: app.id, externalTribeId,
  } });
  assert.equal(preview.response.status, 200, JSON.stringify(preview.data));
  assert.equal(preview.data.partner.id, partner.id);
  assert.equal(preview.data.application.id, app.id);
  assert.equal(preview.data.partnerTribe.id, partnerTribe.data.tribe.id);
  assert.equal(preview.data.socialTribe.id, privateTribe);
  assert.equal(preview.data.socialTribe.name, privateName);
  assert.equal(preview.data.socialTribe.isPrivate, true);
  const previewStored = (await pool.query(
    "SELECT requested_by, token_hash FROM partner_social_link_previews WHERE partner_tribe_id = $1",
    [partnerTribe.data.tribe.id])).rows[0];
  assert.equal(previewStored.requested_by, moderator.id);
  assert.notEqual(previewStored.token_hash, preview.data.confirmationToken);

  const confirmPath = `${linksPath}/confirm`;
  assert.equal((await socialCall(confirmPath, { cookie: member.cookie, method: "POST", body: {
    confirmationToken: preview.data.confirmationToken, confirmPrivateSharing: true,
  } })).response.status, 404);
  assert.equal((await socialCall(confirmPath, { cookie: moderator.cookie, method: "POST", body: {
    confirmationToken: preview.data.confirmationToken,
  } })).response.status, 400);
  assert.equal((await socialCall(confirmPath, { cookie: moderator.cookie, method: "POST", body: {
    confirmationToken: preview.data.confirmationToken, applicationId: otherApp.id,
    confirmPrivateSharing: true,
  } })).response.status, 400);
  await pool.query("UPDATE partner_social_link_previews SET created_at = clock_timestamp() - INTERVAL '5 minutes', expires_at = clock_timestamp() - INTERVAL '1 second' WHERE token_hash = $1", [previewStored.token_hash]);
  assert.equal((await socialCall(confirmPath, { cookie: moderator.cookie, method: "POST", body: {
    confirmationToken: preview.data.confirmationToken, confirmPrivateSharing: true,
  } })).response.status, 409);
  const changedPreview = await socialCall(`${linksPath}/preview`, { cookie: moderator.cookie, method: "POST", body: {
    applicationId: app.id, externalTribeId,
  } });
  assert.equal(changedPreview.response.status, 200);
  await pool.query(
    "UPDATE partner_tribes SET name = 'Partner-owned club renamed', updated_at = clock_timestamp() WHERE id = $1",
    [partnerTribe.data.tribe.id]);
  assert.equal((await socialCall(confirmPath, { cookie: moderator.cookie, method: "POST", body: {
    confirmationToken: changedPreview.data.confirmationToken, confirmPrivateSharing: true,
  } })).response.status, 409);
  const freshPreview = await socialCall(`${linksPath}/preview`, { cookie: moderator.cookie, method: "POST", body: {
    applicationId: app.id, externalTribeId,
  } });
  assert.equal(freshPreview.response.status, 200);
  assert.equal(freshPreview.data.partnerTribe.name, "Partner-owned club renamed");
  await store.setStatus("application", app.id, "disabled");
  assert.equal((await socialCall(`${linksPath}/preview`, { cookie: moderator.cookie, method: "POST", body: {
    applicationId: app.id, externalTribeId,
  } })).response.status, 404);
  assert.equal((await socialCall(confirmPath, { cookie: moderator.cookie, method: "POST", body: {
    confirmationToken: freshPreview.data.confirmationToken, confirmPrivateSharing: true,
  } })).response.status, 404);
  assert.equal((await socialCall(`${linksPath}/${app.id}/${encodeURIComponent(externalTribeId)}`, {
    cookie: moderator.cookie, method: "DELETE",
  })).response.status, 404);
  await store.setStatus("application", app.id, "active");
  const concurrentConfirmations = await Promise.all([1, 2].map(() => socialCall(confirmPath, {
    cookie: moderator.cookie, method: "POST", body: {
      confirmationToken: freshPreview.data.confirmationToken, confirmPrivateSharing: true,
    },
  })));
  assert.equal(concurrentConfirmations.filter(result => result.response.status === 201).length, 1);
  assert.equal(concurrentConfirmations.filter(result => result.response.status === 409).length, 1);
  const linkHistory = (await pool.query(
    `SELECT authorized_by, private_at_authorization, private_data_consent, revoked_by
     FROM partner_social_tribe_link_history WHERE partner_tribe_id = $1 AND revoked_at IS NULL`,
    [partnerTribe.data.tribe.id])).rows[0];
  assert.equal(linkHistory.authorized_by, moderator.id);
  assert.equal(linkHistory.private_at_authorization, true);
  assert.equal(linkHistory.private_data_consent, true);
  assert.equal(linkHistory.revoked_by, null);

  await store.setStatus("application", app.id, "disabled");
  assert.equal((await partnerCall(`/tribes/${encodeURIComponent(externalTribeId)}`)).response.status, 401);
  assert.equal((await partnerCall("/tribes", { method: "POST", body: {
    externalTribeId: `disabled-${marker.slice(0, 10)}`, name: "Disabled app tribe",
    description: "Should not be created.", category: "Games", format: "Online", city: "Partner city",
  } })).response.status, 401);
  const disabledList = await socialCall(linksPath, { cookie: moderator.cookie });
  assert.equal(disabledList.response.status, 200);
  assert.equal(disabledList.data.links.length, 1);
  assert.equal(disabledList.data.links[0].applicationId, app.id);
  const revokePath = `${linksPath}/${app.id}/${encodeURIComponent(externalTribeId)}`;
  assert.equal((await socialCall(revokePath, { cookie: member.cookie, method: "DELETE" })).response.status, 404);
  const revoked = await socialCall(revokePath, { cookie: moderator.cookie, method: "DELETE" });
  assert.equal(revoked.response.status, 200);
  assert.equal(revoked.data.revoked, true);
  const repeatedRevoke = await socialCall(revokePath, { cookie: moderator.cookie, method: "DELETE" });
  assert.equal(repeatedRevoke.response.status, 200);
  assert.equal(repeatedRevoke.data.revoked, false);
  const historyWhileDisabled = await socialCall(linksPath, { cookie: moderator.cookie });
  assert.equal(historyWhileDisabled.response.status, 200);
  assert.equal(historyWhileDisabled.data.links.length, 1);
  assert.equal(historyWhileDisabled.data.links[0].active, false);
  assert.equal((await partnerCall(`/tribes/${encodeURIComponent(externalTribeId)}`)).response.status, 401);
  await store.setStatus("application", app.id, "active");

  const visibleTribe = await partnerCall(`/tribes/${encodeURIComponent(externalTribeId)}`);
  const visibleEvent = await partnerCall(`/events/${encodeURIComponent(externalEventId)}`);
  assert.equal(visibleTribe.data.tribe.name, "Partner-owned club renamed");
  assert.equal(visibleTribe.data.tribe.description, "Partner supplied metadata.");
  assert.equal(visibleEvent.data.event.tribe.name, "Partner-owned club renamed");
  assert.equal(JSON.stringify(visibleTribe.data).includes(privateName), false);
  assert.equal(JSON.stringify(visibleTribe.data).includes(privateDescription), false);
  assert.equal(JSON.stringify(visibleEvent.data).includes(privateName), false);
  const historyList = await socialCall(linksPath, { cookie: moderator.cookie });
  assert.equal(historyList.response.status, 200);
  assert.equal(historyList.data.links.length, 1);
  assert.equal(historyList.data.links[0].authorizedBy, moderator.id);
  assert.equal(historyList.data.links[0].active, false);

  assert.equal((await partnerCall(`/tribes/${encodeURIComponent(externalTribeId)}`, { method: "DELETE" })).response.status, 405);
  const otherAppRevocation = await socialCall(`${linksPath}/${otherApp.id}/${encodeURIComponent(externalTribeId)}`, { cookie: moderator.cookie, method: "DELETE" });
  assert.equal(otherAppRevocation.response.status, 404);
  assert.equal((await partnerCall(`/tribes/${encodeURIComponent(externalTribeId)}`, { apiKey: otherCredential.apiKey })).data.tribe.name, "Other app club");
  assert.equal((await partnerCall(`/tribes/${encodeURIComponent(externalTribeId)}`)).data.tribe.name, "Partner-owned club renamed");
  const afterRevokeTribe = await partnerCall(`/tribes/${encodeURIComponent(externalTribeId)}`);
  const afterRevokeEvent = await partnerCall(`/events/${encodeURIComponent(externalEventId)}`);
  assert.equal(afterRevokeTribe.response.status, 200);
  assert.equal(afterRevokeEvent.response.status, 200);
  assert.equal(afterRevokeTribe.data.tribe.name, "Partner-owned club renamed");
  assert.equal(afterRevokeTribe.data.tribe.description, "Partner supplied metadata.");
  assert.equal(JSON.stringify(afterRevokeTribe.data).includes(privateName), false);
  assert.equal(JSON.stringify(afterRevokeTribe.data).includes(privateDescription), false);
  assert.equal(afterRevokeEvent.data.event.tribe.name, "Partner-owned club renamed");
  assert.equal(JSON.stringify(afterRevokeEvent.data).includes(privateName), false);
  const replayedEvent = await partnerCall("/events", { method: "POST", body: eventPayload });
  assert.equal(replayedEvent.response.status, 200);
  assert.equal(replayedEvent.data.event.tribe.name, "Partner-owned club renamed");
  const patchedEventAfterRevoke = await partnerCall(`/events/${encodeURIComponent(externalEventId)}`, {
    method: "PATCH", body: {
      externalTribeId, title: "Partner event after unlink", description: "Partner event details.",
      startsAt: "2032-04-05T18:00:00Z", location: "Partner location",
    },
  });
  assert.equal(patchedEventAfterRevoke.response.status, 200);
  assert.equal(patchedEventAfterRevoke.data.event.tribe.name, "Partner-owned club renamed");
  assert.equal(JSON.stringify(patchedEventAfterRevoke.data).includes(privateName), false);
  const postRevokeUpdate = await partnerCall(`/tribes/${encodeURIComponent(externalTribeId)}`, {
    method: "PATCH", body: { name: "Partner resource after unlink", description: "Partner supplied after revocation.",
      category: "Games", format: "Online", city: "Partner city" },
  });
  assert.equal(postRevokeUpdate.response.status, 200);
  assert.equal(postRevokeUpdate.data.tribe.name, "Partner resource after unlink");
  const revokedHistory = (await pool.query(
    `SELECT authorized_by, revoked_by, revocation_source
     FROM partner_social_tribe_link_history WHERE partner_tribe_id = $1 ORDER BY authorized_at DESC LIMIT 1`,
    [partnerTribe.data.tribe.id])).rows[0];
  assert.equal(revokedHistory.authorized_by, moderator.id);
  assert.equal(revokedHistory.revoked_by, moderator.id);
  assert.equal(revokedHistory.revocation_source, "moderator");
  assert.equal((await pool.query(
    "SELECT count(*)::int AS count FROM partner_audit_logs WHERE resource_id = $1 AND action = 'tribe.social_link_revoked'",
    [partnerTribe.data.tribe.id])).rows[0].count, 1);
  const unchangedSocialGovernance = (await pool.query(
    `SELECT t.created_by, t.moderator_id, m.status FROM tribes t
     JOIN tribe_memberships m ON m.tribe_id = t.id AND m.user_id = $2 WHERE t.id = $1`,
    [privateTribe, moderator.id])).rows[0];
  assert.equal(unchangedSocialGovernance.created_by, moderator.id);
  assert.equal(unchangedSocialGovernance.moderator_id, moderator.id);
  assert.equal(unchangedSocialGovernance.status, "active");

  const deleteExternalTribeId = `delete-${marker.slice(0, 10)}`;
  const deletePartnerTribe = await partnerCall("/tribes", { method: "POST", body: {
    externalTribeId: deleteExternalTribeId, name: "Delete test resource", description: "Partner metadata for delete test.",
    category: "Games", format: "Online", city: "Belo Horizonte",
  } });
  assert.equal(deletePartnerTribe.response.status, 201);
  const deletePreview = await socialCall(`/api/tribes/${deleteTribe}/partner-links/preview`, {
    cookie: moderator.cookie, method: "POST", body: { applicationId: app.id, externalTribeId: deleteExternalTribeId },
  });
  assert.equal(deletePreview.response.status, 200);
  const deleteLink = await socialCall(`/api/tribes/${deleteTribe}/partner-links/confirm`, {
    cookie: moderator.cookie, method: "POST", body: { confirmationToken: deletePreview.data.confirmationToken },
  });
  assert.equal(deleteLink.response.status, 201);
  const socialDelete = await socialCall(`/api/tribes/${deleteTribe}`, {
    cookie: moderator.cookie, method: "DELETE", body: { confirmationName: `Delete linked tribe ${marker}` },
  });
  assert.equal(socialDelete.response.status, 200, JSON.stringify(socialDelete.data));
  const deletedLinkHistory = (await pool.query(
    `SELECT authorized_by, revoked_by, revocation_source
     FROM partner_social_tribe_link_history WHERE partner_tribe_id = $1 ORDER BY authorized_at DESC LIMIT 1`,
    [deletePartnerTribe.data.tribe.id])).rows[0];
  assert.equal(deletedLinkHistory.authorized_by, moderator.id);
  assert.equal(deletedLinkHistory.revoked_by, null);
  assert.equal(deletedLinkHistory.revocation_source, "tribe_deleted");
  assert.equal((await pool.query(
    "SELECT count(*)::int AS count FROM partner_audit_logs WHERE action = 'tribe.social_link_revoked' AND resource_id = $1",
    [deletePartnerTribe.data.tribe.id])).rows[0].count, 1);
  const afterSocialDelete = await partnerCall(`/tribes/${encodeURIComponent(deleteExternalTribeId)}`);
  assert.equal(afterSocialDelete.response.status, 200);
  assert.equal(afterSocialDelete.data.tribe.name, "Delete test resource");
});
