import test from "node:test";
import assert from "node:assert/strict";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { once } from "node:events";
import { readFile, readdir } from "node:fs/promises";
import pg from "pg";
import { createPartnerStore } from "../partner-store.mjs";
import { createPartnerRequestHandler } from "../partner-api.mjs";

const databaseUrl = process.env.TRIBES_PARTNER_TEST_DATABASE_URL;
const integrationTest = databaseUrl ? test : test.skip;
const migrationDirectory = new URL("../migrations/", import.meta.url);
const future = days => new Date(Date.now() + days * 86400000).toISOString();
const past = days => new Date(Date.now() - days * 86400000).toISOString();

integrationTest("participant retention anchors are immutable across event edits, cancellation and concurrent cleanup", async t => {
  assert.equal(new URL(databaseUrl).pathname, "/tribes_partner_test", "Use exclusivamente o banco isolado tribes_partner_test.");
  const admin = new pg.Pool({ connectionString: databaseUrl });
  const schema = `partner_event_retention_${randomUUID().replaceAll("-", "")}`;
  await admin.query(`CREATE SCHEMA ${schema}`);
  const pool = new pg.Pool({ connectionString: databaseUrl, options: `-c search_path=${schema}`, max: 24 });
  t.after(async () => { await pool.end(); await admin.query(`DROP SCHEMA ${schema} CASCADE`); await admin.end(); });
  for (const file of (await readdir(migrationDirectory)).filter(name => name.endsWith(".sql")).sort()) {
    await pool.query(await readFile(new URL(file, migrationDirectory), "utf8"));
  }

  const store = createPartnerStore(pool);
  const marker = randomUUID();
  const partner = await store.createPartner({ slug: `ret-${marker.slice(0, 8)}`, name: "Retention test partner" });
  const application = await store.createApplication({
    partnerId: partner.id,
    slug: "events",
    name: "Retention test app",
    scopes: ["events:read", "events:write", "participants:write"],
  });
  const key = await store.issueKey({
    applicationId: application.id,
    label: "Retention test key",
    expiresAt: future(1),
  });
  const externalTribeId = `retention-club-${marker.slice(0, 8)}`;
  const tribe = (await store.withAuthorization(key.apiKey, ["events:write"], (client, principal) =>
    store.createPartnerTribe(client, principal, {
      externalTribeId, name: "Retention club", description: "A test-only club.", category: "Games",
      format: "Online", city: "Belo Horizonte", neighborhood: "",
    }))).tribe;

  const server = createServer((request, response) =>
    void createPartnerRequestHandler({ store })(request, response, new URL(request.url, "http://localhost")));
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }));
  const origin = `http://127.0.0.1:${server.address().port}`;
  async function partnerCall(path, { method = "GET", body, apiKey = key.apiKey } = {}) {
    const response = await fetch(`${origin}/api/v1/partners${path}`, {
      method,
      headers: { Authorization: `Bearer ${apiKey}`, ...(body === undefined ? {} : { "Content-Type": "application/json" }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    return { response, data: await response.json() };
  }

  async function createEvent(externalEventId, startsAt, endsAt) {
    const result = await partnerCall("/events", { method: "POST", body: {
      externalEventId, externalTribeId, title: "Retention event", description: "Retention fixture event.",
      startsAt, endsAt, location: "Online",
    } });
    assert.equal(result.response.status, 201, JSON.stringify(result.data));
    return result.data.event;
  }

  async function addParticipant(event, externalParticipantId) {
    const participantId = randomUUID();
    const claimToken = randomBytes(32).toString("base64url");
    const claimHash = createHash("sha256").update(claimToken).digest("hex");
    await pool.query(
      `INSERT INTO partner_event_participants
         (id, partner_id, application_id, partner_event_id, external_participant_id,
          claim_token_hash, claim_expires_at)
       VALUES ($1, $2, $3, $4, $5, $6, clock_timestamp() + INTERVAL '7 days')`,
      [participantId, partner.id, application.id, event.id, externalParticipantId, claimHash]);
    await pool.query(
      `INSERT INTO partner_event_participant_claim_token_hashes (token_hash, participant_id, secret_version)
       VALUES ($1, $2, 1)`, [claimHash, participantId]);
    await pool.query(
      `INSERT INTO partner_event_participant_history
         (partner_id, application_id, partner_event_id, participant_id, participant_resource_id,
          action, actor_type)
       VALUES ($1, $2, $3, $4, $4, 'participant.created', 'partner')`,
      [partner.id, application.id, event.id, participantId]);
    await pool.query(
      `INSERT INTO partner_audit_logs
         (partner_id, application_id, action, resource_id, partner_event_id)
       VALUES ($1, $2, 'participant.created', $3, $4)`,
      [partner.id, application.id, participantId, event.id]);
    return { participantId, claimToken };
  }

  const preRetentionEvent = await createEvent(`before-${marker}`, past(82), past(81));
  const preRetentionParticipant = await addParticipant(preRetentionEvent, `ticket-before-${marker}`);

  const otherPartner = await store.createPartner({ slug: `other-${marker.slice(0, 8)}`, name: "Other retention partner" });
  const otherApplication = await store.createApplication({
    partnerId: otherPartner.id,
    slug: "other-events",
    name: "Other retention app",
    scopes: ["events:read", "events:write", "organizers:write", "participants:write"],
  });
  const otherKey = await store.issueKey({
    applicationId: otherApplication.id,
    label: "Other retention key",
    expiresAt: future(1),
  });
  const otherTribeId = `other-club-${marker.slice(0, 8)}`;
  const otherTribe = await partnerCall("/tribes", { method: "POST", apiKey: otherKey.apiKey, body: {
    externalTribeId: otherTribeId, name: "Other retention club", description: "Another isolated club.",
    category: "Games", format: "Online", city: "Belo Horizonte",
  } });
  assert.equal(otherTribe.response.status, 201, JSON.stringify(otherTribe.data));
  const otherEventExternalId = `other-event-${marker.slice(0, 8)}`;
  const otherEvent = await partnerCall("/events", { method: "POST", apiKey: otherKey.apiKey, body: {
    externalEventId: otherEventExternalId, externalTribeId: otherTribeId,
    title: "Other retention event", description: "Other tenant event.",
    startsAt: future(2), endsAt: future(2.1), location: "Online",
  } });
  assert.equal(otherEvent.response.status, 201, JSON.stringify(otherEvent.data));
  // A second tenant can submit the same bearer secret, but receives only a
  // generic uniqueness conflict with no owner information.
  const crossTenantSecretReuse = await partnerCall(
    `/events/${encodeURIComponent(otherEventExternalId)}/participants/reused-secret`,
    { method: "POST", apiKey: otherKey.apiKey, body: { claimToken: preRetentionParticipant.claimToken } },
  );
  assert.equal(crossTenantSecretReuse.response.status, 409);
  assert.equal(crossTenantSecretReuse.data.code, "claim_token_conflict");
  for (const identifyingValue of [partner.id, partner.slug, partner.name, application.id, application.slug]) {
    assert.equal(JSON.stringify(crossTenantSecretReuse.data).includes(identifyingValue), false,
      "a global tombstone collision does not disclose its partner or application");
  }
  const tombstoneLookup = await partnerCall("/participant-secret-hashes", { apiKey: otherKey.apiKey });
  assert.equal(tombstoneLookup.response.status, 404, "there is no partner API endpoint to enumerate tombstones");

  const cancellableEvent = await createEvent(`cancel-${marker}`, future(10), future(10.1));
  const cancelledParticipant = await addParticipant(cancellableEvent, `ticket-cancel-${marker}`);
  const cancelled = await partnerCall(`/events/${encodeURIComponent(cancellableEvent.externalEventId)}/cancel`, { method: "POST" });
  assert.equal(cancelled.response.status, 200, JSON.stringify(cancelled.data));
  const cancelledAnchor = (await pool.query(
    "SELECT participant_retention_at, cancelled_at FROM partner_events WHERE id = $1", [cancellableEvent.id])).rows[0];
  assert.equal(cancelledAnchor.participant_retention_at.getTime(), cancelledAnchor.cancelled_at.getTime(),
    "cancellation before the scheduled end anchors retention at cancellation time");
  assert.equal((await partnerCall(`/events/${encodeURIComponent(cancellableEvent.externalEventId)}`, {
    method: "PATCH", body: { externalTribeId, title: "Retention event", description: "Retention fixture event.",
      startsAt: future(20), endsAt: future(20.1), location: "Online", cost: "", maxAttendees: null },
  })).response.status, 409, "cancelled events remain terminal");

  const noParticipantEvent = await createEvent(`empty-${marker}`, past(5), past(4));
  const emptyRescheduled = await partnerCall(`/events/${encodeURIComponent(noParticipantEvent.externalEventId)}`, {
    method: "PATCH", body: { externalTribeId, title: "Retention event", description: "Retention fixture event.",
      startsAt: future(20), endsAt: future(20.1), location: "Online", cost: "", maxAttendees: null },
  });
  assert.equal(emptyRescheduled.response.status, 200, JSON.stringify(emptyRescheduled.data));
  assert.equal((await pool.query("SELECT participant_retention_at FROM partner_events WHERE id = $1", [noParticipantEvent.id])).rows[0].participant_retention_at, null,
    "events without participants retain existing rescheduling behavior and do not acquire a participant anchor");

  // The first job establishes the immutable scheduled-end marker. At day 82 the
  // participant remains, and moving the event dates can no longer defer cleanup.
  const beforeWindowRun = await store.deleteExpiredPartnerParticipantData();
  assert.equal(beforeWindowRun.participants_processed, 0);
  const beforeNinetyDays = (await pool.query(
    "SELECT participant_retention_at FROM partner_events WHERE id = $1", [preRetentionEvent.id])).rows[0].participant_retention_at;
  assert.ok(Math.abs(beforeNinetyDays.getTime() - Date.parse(preRetentionEvent.endsAt)) < 5000,
    "retention anchor records the immutable scheduled end");
  assert.ok((await pool.query("SELECT 1 FROM partner_event_participants WHERE id = $1", [preRetentionParticipant.participantId])).rowCount,
    "participants remain before the 90-day retention window");
  await assert.rejects(
    pool.query("UPDATE partner_events SET ends_at = $2 WHERE id = $1", [preRetentionEvent.id, future(31)]),
    error => error.code === "23514" && error.constraint === "partner_event_retention_schedule_immutable",
    "the database trigger independently rejects schedule rewrites after the event end",
  );
  const attemptedAnchorRewrite = (await pool.query(
    "UPDATE partner_events SET participant_retention_at = clock_timestamp() WHERE id = $1 RETURNING participant_retention_at",
    [preRetentionEvent.id])).rows[0].participant_retention_at;
  assert.equal(attemptedAnchorRewrite.getTime(), beforeNinetyDays.getTime(), "a terminal anchor cannot be rewritten");
  const extended = await partnerCall(`/events/${encodeURIComponent(preRetentionEvent.externalEventId)}`, {
    method: "PATCH", body: { externalTribeId, title: "Retention event", description: "Retention fixture event.",
      startsAt: future(30), endsAt: future(30.1), location: "Online", cost: "", maxAttendees: null },
  });
  assert.equal(extended.response.status, 409, JSON.stringify(extended.data));
  assert.equal(extended.data.code, "event_schedule_locked");
  assert.equal((await pool.query("SELECT ends_at FROM partner_events WHERE id = $1", [preRetentionEvent.id])).rows[0].ends_at.getTime(), Date.parse(preRetentionEvent.endsAt));

  const expiredEvent = await createEvent(`expired-${marker}`, past(102), past(101));
  const expiredParticipant = await addParticipant(expiredEvent, `ticket-expired-${marker}`);
  const noEndsAtEvent = await createEvent(`no-end-${marker}`, past(102), null);
  const noEndsAtParticipant = await addParticipant(noEndsAtEvent, `ticket-no-end-${marker}`);

  // Concurrent date extension and cleanup both serialize on the event row.
  const concurrentExtension = partnerCall(`/events/${encodeURIComponent(expiredEvent.externalEventId)}`, {
    method: "PATCH", body: { externalTribeId, title: "Retention event", description: "Retention fixture event.",
      startsAt: future(40), endsAt: future(40.1), location: "Online", cost: "", maxAttendees: null },
  });
  const cleanupOne = store.deleteExpiredPartnerParticipantData();
  const cleanupTwo = store.deleteExpiredPartnerParticipantData();
  const [extensionResult, runOne, runTwo] = await Promise.all([concurrentExtension, cleanupOne, cleanupTwo]);
  assert.equal(extensionResult.response.status, 409, JSON.stringify(extensionResult.data));
  assert.equal(extensionResult.data.code, "event_schedule_locked");
  assert.deepEqual([runOne.participants_processed, runTwo.participants_processed].sort((a, b) => a - b), [0, 2]);
  const runRows = (await pool.query(
    `SELECT started_at, completed_at, duration_ms, participants_processed,
            history_rows_aggregated, audit_rows_aggregated
     FROM partner_participant_retention_runs ORDER BY completed_at`,
  )).rows;
  assert.equal(runRows.length, 3);
  assert.ok(runRows.every(run => run.started_at && run.completed_at && Number(run.duration_ms) >= 0));
  assert.equal(runRows.filter(run => run.participants_processed === 2).length, 1);
  assert.ok(runRows.some(run => run.history_rows_aggregated === 2 && run.audit_rows_aggregated === 2));
  assert.equal((await pool.query(
    "SELECT count(*)::int AS count FROM partner_event_participants WHERE id = ANY($1::uuid[])",
    [[expiredParticipant.participantId, noEndsAtParticipant.participantId]])).rows[0].count, 0);
  assert.equal((await pool.query(
    "SELECT count(*)::int AS count FROM partner_event_participant_history WHERE participant_resource_id = ANY($1::uuid[]) OR participant_id = ANY($1::uuid[])",
    [[expiredParticipant.participantId, noEndsAtParticipant.participantId]])).rows[0].count, 0);
  assert.equal((await pool.query(
    "SELECT count(*)::int AS count FROM partner_audit_logs WHERE resource_id = ANY($1::uuid[])",
    [[expiredParticipant.participantId, noEndsAtParticipant.participantId]])).rows[0].count, 0);
  assert.equal((await pool.query(
    "SELECT count(*)::int AS count FROM partner_event_participant_claim_token_hashes WHERE participant_id = ANY($1::uuid[])",
    [[expiredParticipant.participantId, noEndsAtParticipant.participantId]])).rows[0].count, 0);
  for (const event of [expiredEvent, noEndsAtEvent]) {
    assert.ok((await pool.query(
      `SELECT 1 FROM partner_event_participant_audit_aggregates
       WHERE partner_id = $1 AND application_id = $2 AND partner_event_id = $3
         AND source = 'participant_history' AND action = 'participant.created'`,
      [partner.id, application.id, event.id])).rowCount);
  }
  assert.ok((await pool.query(
    "SELECT 1 FROM partner_event_participants WHERE id = $1", [cancelledParticipant.participantId])).rowCount,
  "cancellation starts a fresh 90-day retention window rather than purging immediately");
});
