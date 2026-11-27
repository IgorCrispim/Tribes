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

integrationTest("partner organizer grants enforce human authorization, independent lifecycles and tenant isolation", async t => {
  assert.equal(new URL(databaseUrl).pathname, "/tribes_partner_test", "Use exclusivamente o banco isolado tribes_partner_test.");
  const pool = new pg.Pool({ connectionString: databaseUrl, max: 24 });
  const store = createPartnerStore(pool);
  const marker = randomUUID();
  let partner;
  let otherPartner;
  const users = [];
  const tribes = [];
  const applicationIds = [];
  t.after(async () => {
    if (tribes.length) await pool.query("DELETE FROM tribes WHERE id = ANY($1::uuid[])", [tribes]);
    const partnerIds = [partner?.id, otherPartner?.id].filter(Boolean);
    if (partnerIds.length) {
      await pool.query("DELETE FROM partner_social_link_previews WHERE partner_id = ANY($1::uuid[])", [partnerIds]);
      await pool.query("DELETE FROM partner_organizer_grant_history WHERE partner_id = ANY($1::uuid[])", [partnerIds]);
      await pool.query("DELETE FROM partner_social_tribe_link_history WHERE partner_id = ANY($1::uuid[])", [partnerIds]);
      await pool.query("DELETE FROM partner_audit_logs WHERE partner_id = ANY($1::uuid[])", [partnerIds]);
      await pool.query("DELETE FROM partner_events WHERE partner_id = ANY($1::uuid[])", [partnerIds]);
      await pool.query("DELETE FROM partner_tribes WHERE partner_id = ANY($1::uuid[])", [partnerIds]);
      await pool.query("DELETE FROM partner_api_keys WHERE partner_id = ANY($1::uuid[])", [partnerIds]);
      await pool.query("DELETE FROM partner_rate_limits WHERE application_id = ANY($1::uuid[])", [applicationIds]);
      await pool.query("DELETE FROM partner_applications WHERE partner_id = ANY($1::uuid[])", [partnerIds]);
      await pool.query("DELETE FROM partners WHERE id = ANY($1::uuid[])", [partnerIds]);
    }
    if (users.length) {
      await pool.query("DELETE FROM user_sessions WHERE user_id = ANY($1::uuid[])", [users.map(user => user.id)]);
      await pool.query("DELETE FROM tribe_memberships WHERE user_id = ANY($1::uuid[])", [users.map(user => user.id)]);
      await pool.query("DELETE FROM users WHERE id = ANY($1::uuid[])", [users.map(user => user.id)]);
    }
    await pool.end();
  });

  async function createUser(label) {
    const row = (await pool.query(
      "INSERT INTO users (display_name, email, password_hash) VALUES ($1, $2, 'test-only') RETURNING id",
      [label, `${label.toLowerCase()}-${marker}@example.test`])).rows[0];
    const token = createSessionToken();
    await pool.query(
      "INSERT INTO user_sessions (token_hash, user_id, expires_at) VALUES ($1, $2, clock_timestamp() + INTERVAL '1 day')",
      [digestSessionToken(token), row.id]);
    const user = { id: row.id, cookie: `tribes_session=${token}`, email: `${label.toLowerCase()}-${marker}@example.test` };
    users.push(user);
    return user;
  }

  async function createSocialTribe(moderator, name) {
    const row = (await pool.query(
      `INSERT INTO tribes (name, description, category, format, city, created_by, moderator_id)
       VALUES ($1, 'Grant test tribe.', 'Games', 'Online', 'Belo Horizonte', $2, $2) RETURNING id`,
      [name, moderator.id])).rows[0];
    tribes.push(row.id);
    await pool.query("INSERT INTO tribe_memberships (tribe_id, user_id) VALUES ($1, $2)", [row.id, moderator.id]);
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

  async function partnerCall(path, { apiKey, method = "GET", body } = {}) {
    const response = await fetch(`${origin}/api/v1/partners${path}`, {
      method,
      headers: { Authorization: `Bearer ${apiKey}`, ...(body === undefined ? {} : { "Content-Type": "application/json" }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    return { response, data: await response.json() };
  }

  const moderator = await createUser("Grant moderator");
  const firstMember = await createUser("Grant member one");
  const secondMember = await createUser("Grant member two");
  const outsider = await createUser("Grant outsider");
  const socialTribeName = `Grant social tribe ${marker}`;
  const socialTribeId = await createSocialTribe(moderator, socialTribeName);
  await pool.query("INSERT INTO tribe_memberships (tribe_id, user_id) VALUES ($1, $2), ($1, $3)", [socialTribeId, firstMember.id, secondMember.id]);

  partner = await store.createPartner({ slug: `grant-${marker.slice(0, 8)}`, name: "Grant test partner" });
  const appScopes = ["organizers:write", "organizer-grants:read"];
  const application = await store.createApplication({ partnerId: partner.id, slug: "main", name: "Grant main app", scopes: appScopes });
  applicationIds.push(application.id);
  const fullKey = await store.issueKey({ applicationId: application.id, label: "Grant read key", scopes: appScopes, expiresAt: expiry() });
  const narrowKey = await store.issueKey({ applicationId: application.id, label: "No grants read", scopes: ["organizers:write"], expiresAt: expiry() });
  const externalTribeId = `grant-${marker}`;
  const provisional = await partnerCall("/tribes", { apiKey: fullKey.apiKey, method: "POST", body: {
    externalTribeId, name: "Partner provisional club", description: "Partner-owned data.",
    category: "Games", format: "Online", city: "Belo Horizonte",
  } });
  assert.equal(provisional.response.status, 201, JSON.stringify(provisional.data));

  const linkPreview = await socialCall(`/api/tribes/${socialTribeId}/partner-links/preview`, {
    cookie: moderator.cookie, method: "POST", body: { applicationId: application.id, externalTribeId },
  });
  assert.equal(linkPreview.response.status, 200, JSON.stringify(linkPreview.data));
  const linked = await socialCall(`/api/tribes/${socialTribeId}/partner-links/confirm`, {
    cookie: moderator.cookie, method: "POST", body: { confirmationToken: linkPreview.data.confirmationToken },
  });
  assert.equal(linked.response.status, 201, JSON.stringify(linked.data));

  const grantPath = `/api/tribes/${socialTribeId}/partner-grants`;
  assert.equal((await socialCall(grantPath, { method: "GET" })).response.status, 401);
  assert.equal((await socialCall(grantPath, { cookie: firstMember.cookie, method: "POST", body: {
    applicationId: application.id, externalTribeId, beneficiaryUserId: firstMember.id,
  } })).response.status, 404);
  const forgedGrant = await socialCall(grantPath, { cookie: moderator.cookie, method: "POST", body: {
    applicationId: application.id, externalTribeId, beneficiaryUserId: firstMember.id, grantedBy: outsider.id,
  } });
  assert.equal(forgedGrant.response.status, 400);
  const clientSelectedCapability = await socialCall(grantPath, { cookie: moderator.cookie, method: "POST", body: {
    applicationId: application.id, externalTribeId, beneficiaryUserId: firstMember.id, capability: "moderators:write",
  } });
  assert.equal(clientSelectedCapability.response.status, 400);
  const nonMemberGrant = await socialCall(grantPath, { cookie: moderator.cookie, method: "POST", body: {
    applicationId: application.id, externalTribeId, beneficiaryUserId: outsider.id,
  } });
  assert.equal(nonMemberGrant.response.status, 404);
  assert.equal(nonMemberGrant.data.code, "beneficiary_not_active_member");

  const beforeSocialState = (await pool.query(
    `SELECT (SELECT count(*) FROM feed_items WHERE tribe_id = $1)::int AS feed,
            (SELECT count(*) FROM tribe_events e JOIN feed_items f ON f.id = e.content_id WHERE f.tribe_id = $1)::int AS events,
            (SELECT count(*) FROM tribe_memberships WHERE tribe_id = $1)::int AS memberships`,
    [socialTribeId])).rows[0];
  const beforeGovernance = (await pool.query(
    "SELECT created_by, moderator_id, name FROM tribes WHERE id = $1", [socialTribeId])).rows[0];
  const issueFirstMember = () => socialCall(grantPath, { cookie: moderator.cookie, method: "POST", body: {
    applicationId: application.id, externalTribeId, beneficiaryUserId: firstMember.id,
  } });
  const concurrentGrants = await Promise.all([issueFirstMember(), issueFirstMember(), issueFirstMember()]);
  assert.equal(concurrentGrants.filter(result => result.response.status === 201 && result.data.created).length, 1);
  assert.equal(concurrentGrants.filter(result => result.response.status === 200 && !result.data.created).length, 2);
  const firstGrantId = concurrentGrants[0].data.grant.id;
  assert.ok(concurrentGrants.every(result => result.data.grant.id === firstGrantId));
  const secondGrant = await socialCall(grantPath, { cookie: moderator.cookie, method: "POST", body: {
    applicationId: application.id, externalTribeId, beneficiaryUserId: secondMember.id,
  } });
  assert.equal(secondGrant.response.status, 201, JSON.stringify(secondGrant.data));
  const secondGrantId = secondGrant.data.grant.id;
  assert.equal((await pool.query(
    "SELECT count(*)::int AS count FROM partner_audit_logs WHERE action = 'organizer.grant_issued' AND resource_id = $1",
    [provisional.data.tribe.id])).rows[0].count, 2);
  const grantAuditRows = (await pool.query(
    "SELECT action, resource_id FROM partner_audit_logs WHERE partner_id = $1 AND action LIKE 'organizer.grant_%'",
    [partner.id])).rows;
  assert.equal(JSON.stringify(grantAuditRows).includes(firstMember.id), false);
  assert.equal(JSON.stringify(grantAuditRows).includes(firstMember.email), false);

  const grantsPath = `/tribes/${encodeURIComponent(externalTribeId)}/organizer-grants`;
  const visibleGrants = await partnerCall(grantsPath, { apiKey: fullKey.apiKey });
  assert.equal(visibleGrants.response.status, 200, JSON.stringify(visibleGrants.data));
  assert.deepEqual(new Set(visibleGrants.data.grants.map(grant => grant.beneficiaryUserId)), new Set([firstMember.id, secondMember.id]));
  assert.ok(visibleGrants.data.grants.every(grant => grant.capability === "organizer.manage"));
  assert.equal(JSON.stringify(visibleGrants.data).includes(firstMember.email), false);
  assert.equal(JSON.stringify(visibleGrants.data).includes("display_name"), false);
  assert.equal((await partnerCall(grantsPath, { apiKey: narrowKey.apiKey })).response.status, 403);
  assert.equal((await partnerCall(`/tribes/${encodeURIComponent(externalTribeId)}`, {
    apiKey: narrowKey.apiKey, method: "PATCH", body: {
      name: "must not update", description: "No widening of organizers write.", category: "Games", format: "Online", city: "Belo Horizonte",
    },
  })).response.status, 409);

  otherPartner = await store.createPartner({ slug: `other-${marker.slice(0, 8)}`, name: "Other grant partner" });
  const otherApp = await store.createApplication({ partnerId: otherPartner.id, slug: "other", name: "Other partner app", scopes: appScopes });
  applicationIds.push(otherApp.id);
  const otherKey = await store.issueKey({ applicationId: otherApp.id, label: "Other partner key", scopes: appScopes, expiresAt: expiry() });
  const otherResource = await partnerCall("/tribes", { apiKey: otherKey.apiKey, method: "POST", body: {
    externalTribeId, name: "Other provisional club", description: "Isolated partner data.",
    category: "Games", format: "Online", city: "Other city",
  } });
  assert.equal(otherResource.response.status, 201);
  assert.deepEqual((await partnerCall(grantsPath, { apiKey: otherKey.apiKey })).data.grants, []);
  const samePartnerOtherApp = await store.createApplication({ partnerId: partner.id, slug: "secondary", name: "Secondary app", scopes: appScopes });
  applicationIds.push(samePartnerOtherApp.id);
  const samePartnerOtherKey = await store.issueKey({ applicationId: samePartnerOtherApp.id, label: "Secondary key", scopes: appScopes, expiresAt: expiry() });
  await partnerCall("/tribes", { apiKey: samePartnerOtherKey.apiKey, method: "POST", body: {
    externalTribeId, name: "Secondary provisional club", description: "Separate application data.",
    category: "Games", format: "Online", city: "Secondary city",
  } });
  assert.deepEqual((await partnerCall(grantsPath, { apiKey: samePartnerOtherKey.apiKey })).data.grants, []);

  await pool.query(
    "UPDATE tribe_memberships SET status = 'left', left_at = clock_timestamp() WHERE tribe_id = $1 AND user_id = $2",
    [socialTribeId, firstMember.id]);
  const afterLeave = await partnerCall(grantsPath, { apiKey: fullKey.apiKey });
  assert.deepEqual(afterLeave.data.grants.map(grant => grant.beneficiaryUserId), [secondMember.id]);
  const leftGrant = (await pool.query("SELECT revoked_at, revocation_source FROM partner_organizer_grant_history WHERE id = $1", [firstGrantId])).rows[0];
  assert.ok(leftGrant.revoked_at);
  assert.equal(leftGrant.revocation_source, "membership_ended");
  assert.equal((await pool.query(
    "SELECT count(*)::int AS count FROM partner_audit_logs WHERE action = 'organizer.grant_membership_ended' AND resource_id = $1",
    [provisional.data.tribe.id])).rows[0].count, 1);
  await pool.query(
    "UPDATE tribe_memberships SET status = 'active', joined_at = clock_timestamp(), left_at = NULL WHERE tribe_id = $1 AND user_id = $2",
    [socialTribeId, firstMember.id]);
  assert.deepEqual((await partnerCall(grantsPath, { apiKey: fullKey.apiKey })).data.grants.map(grant => grant.beneficiaryUserId), [secondMember.id]);

  const beforeUnlinkRows = (await pool.query(
    "SELECT id, revoked_at FROM partner_organizer_grant_history WHERE partner_tribe_id = $1 ORDER BY id",
    [provisional.data.tribe.id])).rows;
  const unlinked = await socialCall(`/api/tribes/${socialTribeId}/partner-links/${application.id}/${encodeURIComponent(externalTribeId)}`, {
    cookie: moderator.cookie, method: "DELETE",
  });
  assert.equal(unlinked.response.status, 200);
  const afterUnlinkRows = (await pool.query(
    "SELECT id, revoked_at FROM partner_organizer_grant_history WHERE partner_tribe_id = $1 ORDER BY id",
    [provisional.data.tribe.id])).rows;
  assert.deepEqual(afterUnlinkRows, beforeUnlinkRows);
  const hiddenAfterUnlink = await partnerCall(grantsPath, { apiKey: fullKey.apiKey });
  assert.deepEqual(hiddenAfterUnlink.data.grants, []);
  assert.equal(JSON.stringify(hiddenAfterUnlink.data).includes(firstMember.id), false);
  assert.equal(JSON.stringify(hiddenAfterUnlink.data).includes(secondMember.id), false);
  assert.equal(JSON.stringify(hiddenAfterUnlink.data).includes(socialTribeName), false);
  assert.equal((await socialCall(grantPath, { cookie: moderator.cookie, method: "POST", body: {
    applicationId: application.id, externalTribeId, beneficiaryUserId: secondMember.id,
  } })).response.status, 404);
  const partnerMetadataAfterUnlink = await partnerCall(`/tribes/${encodeURIComponent(externalTribeId)}`, { apiKey: fullKey.apiKey });
  assert.equal(partnerMetadataAfterUnlink.data.tribe.name, "Partner provisional club");
  assert.equal(partnerMetadataAfterUnlink.data.tribe.linkedToSocialTribe, false);

  const otherSocialTribeName = `Alternate grant tribe ${marker}`;
  const otherSocialTribeId = await createSocialTribe(moderator, otherSocialTribeName);
  await pool.query("INSERT INTO tribe_memberships (tribe_id, user_id) VALUES ($1, $2)", [otherSocialTribeId, secondMember.id]);
  const otherLinkPreview = await socialCall(`/api/tribes/${otherSocialTribeId}/partner-links/preview`, {
    cookie: moderator.cookie, method: "POST", body: { applicationId: application.id, externalTribeId },
  });
  assert.equal(otherLinkPreview.response.status, 200);
  const linkedToOtherSocialTribe = await socialCall(`/api/tribes/${otherSocialTribeId}/partner-links/confirm`, {
    cookie: moderator.cookie, method: "POST", body: { confirmationToken: otherLinkPreview.data.confirmationToken },
  });
  assert.equal(linkedToOtherSocialTribe.response.status, 201);
  assert.deepEqual((await partnerCall(grantsPath, { apiKey: fullKey.apiKey })).data.grants, []);
  const otherSocialGrant = await socialCall(`/api/tribes/${otherSocialTribeId}/partner-grants`, {
    cookie: moderator.cookie, method: "POST", body: {
      applicationId: application.id, externalTribeId, beneficiaryUserId: secondMember.id,
    },
  });
  assert.equal(otherSocialGrant.response.status, 201, JSON.stringify(otherSocialGrant.data));
  assert.notEqual(otherSocialGrant.data.grant.id, secondGrantId);
  assert.deepEqual((await partnerCall(grantsPath, { apiKey: fullKey.apiKey })).data.grants.map(grant => grant.beneficiaryUserId), [secondMember.id]);
  assert.equal((await socialCall(`/api/tribes/${otherSocialTribeId}/partner-grants/${otherSocialGrant.data.grant.id}`, {
    cookie: moderator.cookie, method: "DELETE",
  })).data.revoked, true);
  assert.deepEqual((await partnerCall(grantsPath, { apiKey: fullKey.apiKey })).data.grants, []);
  assert.equal((await socialCall(`/api/tribes/${otherSocialTribeId}/partner-links/${application.id}/${encodeURIComponent(externalTribeId)}`, {
    cookie: moderator.cookie, method: "DELETE",
  })).response.status, 200);

  const repreview = await socialCall(`/api/tribes/${socialTribeId}/partner-links/preview`, {
    cookie: moderator.cookie, method: "POST", body: { applicationId: application.id, externalTribeId },
  });
  assert.equal(repreview.response.status, 200);
  const relinked = await socialCall(`/api/tribes/${socialTribeId}/partner-links/confirm`, {
    cookie: moderator.cookie, method: "POST", body: { confirmationToken: repreview.data.confirmationToken },
  });
  assert.equal(relinked.response.status, 201);
  const visibleAfterRelink = await partnerCall(grantsPath, { apiKey: fullKey.apiKey });
  assert.deepEqual(visibleAfterRelink.data.grants.map(grant => grant.beneficiaryUserId), [secondMember.id]);
  assert.equal(visibleAfterRelink.data.grants.some(grant => grant.id === firstGrantId), false);
  assert.equal(visibleAfterRelink.data.grants.some(grant => grant.id === otherSocialGrant.data.grant.id), false);

  const revokedGrant = await socialCall(`/api/tribes/${socialTribeId}/partner-grants/${secondGrantId}`, {
    cookie: moderator.cookie, method: "DELETE",
  });
  assert.equal(revokedGrant.response.status, 200);
  assert.equal(revokedGrant.data.revoked, true);
  assert.equal((await socialCall(`/api/tribes/${socialTribeId}/partner-grants/${secondGrantId}`, {
    cookie: moderator.cookie, method: "DELETE",
  })).data.revoked, false);
  assert.equal((await pool.query("SELECT social_tribe_id FROM partner_tribes WHERE id = $1", [provisional.data.tribe.id])).rows[0].social_tribe_id, socialTribeId);
  assert.equal((await pool.query(
    "SELECT count(*)::int AS count FROM partner_audit_logs WHERE action = 'organizer.grant_revoked' AND resource_id = $1",
    [provisional.data.tribe.id])).rows[0].count, 2);

  const thirdGrant = await socialCall(grantPath, { cookie: moderator.cookie, method: "POST", body: {
    applicationId: application.id, externalTribeId, beneficiaryUserId: secondMember.id,
  } });
  assert.equal(thirdGrant.response.status, 201);
  const thirdGrantId = thirdGrant.data.grant.id;
  await store.setStatus("application", application.id, "disabled");
  assert.equal((await partnerCall(grantsPath, { apiKey: fullKey.apiKey })).response.status, 401);
  assert.equal((await partnerCall("/status", { apiKey: fullKey.apiKey })).response.status, 401);
  assert.equal((await partnerCall("/tribes", { apiKey: fullKey.apiKey, method: "POST", body: {
    externalTribeId: `disabled-${marker}`, name: "Disabled app resource", description: "Must not be created.",
    category: "Games", format: "Online", city: "Belo Horizonte",
  } })).response.status, 401);
  assert.equal((await socialCall(`/api/tribes/${socialTribeId}/partner-grants/${thirdGrantId}`, {
    cookie: moderator.cookie, method: "DELETE",
  })).data.revoked, true);
  await store.setStatus("application", application.id, "active");

  const fourthGrant = await socialCall(grantPath, { cookie: moderator.cookie, method: "POST", body: {
    applicationId: application.id, externalTribeId, beneficiaryUserId: secondMember.id,
  } });
  assert.equal(fourthGrant.response.status, 201);
  await pool.query("UPDATE partner_applications SET scopes = ARRAY['organizers:write'] WHERE id = $1", [application.id]);
  assert.equal((await partnerCall(grantsPath, { apiKey: fullKey.apiKey })).response.status, 403);
  const missingScopeGrant = await socialCall(grantPath, { cookie: moderator.cookie, method: "POST", body: {
    applicationId: application.id, externalTribeId, beneficiaryUserId: firstMember.id,
  } });
  assert.equal(missingScopeGrant.response.status, 409);
  assert.equal(missingScopeGrant.data.code, "partner_application_scope_missing");
  assert.equal((await socialCall(`/api/tribes/${socialTribeId}/partner-grants/${fourthGrant.data.grant.id}`, {
    cookie: moderator.cookie, method: "DELETE",
  })).data.revoked, true);
  await pool.query("UPDATE partner_applications SET scopes = $2::text[] WHERE id = $1", [application.id, appScopes]);

  const stateAfterGrants = (await pool.query(
    `SELECT (SELECT count(*) FROM feed_items WHERE tribe_id = $1)::int AS feed,
            (SELECT count(*) FROM tribe_events e JOIN feed_items f ON f.id = e.content_id WHERE f.tribe_id = $1)::int AS events,
            (SELECT count(*) FROM tribe_memberships WHERE tribe_id = $1)::int AS memberships`,
    [socialTribeId])).rows[0];
  assert.deepEqual(stateAfterGrants, beforeSocialState);
  assert.deepEqual((await pool.query("SELECT created_by, moderator_id, name FROM tribes WHERE id = $1", [socialTribeId])).rows[0], beforeGovernance);

  const deleteExternalId = `delete-${marker}`;
  const deleteSocialTribeName = `Delete grant tribe ${marker}`;
  const deleteSocialTribeId = await createSocialTribe(moderator, deleteSocialTribeName);
  await pool.query("INSERT INTO tribe_memberships (tribe_id, user_id) VALUES ($1, $2)", [deleteSocialTribeId, secondMember.id]);
  await partnerCall("/tribes", { apiKey: fullKey.apiKey, method: "POST", body: {
    externalTribeId: deleteExternalId, name: "Delete grant resource", description: "Delete test resource.",
    category: "Games", format: "Online", city: "Belo Horizonte",
  } });
  const deleteLinkPreview = await socialCall(`/api/tribes/${deleteSocialTribeId}/partner-links/preview`, {
    cookie: moderator.cookie, method: "POST", body: { applicationId: application.id, externalTribeId: deleteExternalId },
  });
  assert.equal(deleteLinkPreview.response.status, 200);
  assert.equal((await socialCall(`/api/tribes/${deleteSocialTribeId}/partner-links/confirm`, {
    cookie: moderator.cookie, method: "POST", body: { confirmationToken: deleteLinkPreview.data.confirmationToken },
  })).response.status, 201);
  const deleteGrantPath = `/api/tribes/${deleteSocialTribeId}/partner-grants`;
  const deleteGrant = await socialCall(deleteGrantPath, { cookie: moderator.cookie, method: "POST", body: {
    applicationId: application.id, externalTribeId: deleteExternalId, beneficiaryUserId: secondMember.id,
  } });
  assert.equal(deleteGrant.response.status, 201);
  const deletedSocialTribe = await socialCall(`/api/tribes/${deleteSocialTribeId}`, {
    cookie: moderator.cookie, method: "DELETE", body: { confirmationName: deleteSocialTribeName },
  });
  assert.equal(deletedSocialTribe.response.status, 200, JSON.stringify(deletedSocialTribe.data));
  const deletedGrantHistory = (await pool.query(
    "SELECT revoked_at, revocation_source FROM partner_organizer_grant_history WHERE id = $1", [deleteGrant.data.grant.id])).rows[0];
  assert.ok(deletedGrantHistory.revoked_at);
  assert.equal(deletedGrantHistory.revocation_source, "social_tribe_deleted");
  assert.equal((await pool.query(
    "SELECT count(*)::int AS count FROM partner_audit_logs WHERE action = 'organizer.grant_social_tribe_deleted' AND resource_id = $1",
    [deleteLinkPreview.data.partnerTribe.id])).rows[0].count, 1);
});
