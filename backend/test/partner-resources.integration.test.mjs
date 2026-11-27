import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { once } from "node:events";
import { readFile, readdir } from "node:fs/promises";
import pg from "pg";
import { createPartnerStore } from "../partner-store.mjs";
import { createPartnerRequestHandler } from "../partner-api.mjs";

const databaseUrl = process.env.TRIBES_PARTNER_TEST_DATABASE_URL;
const integrationTest = databaseUrl ? test : test.skip;
const migrations = new URL("../migrations/", import.meta.url);
const expiry = () => new Date(Date.now() + 86400000).toISOString();

integrationTest("partner resources are provisional, application-owned and idempotent under concurrency", async t => {
  assert.equal(new URL(databaseUrl).pathname, "/tribes_partner_test", "Use exclusivamente o banco isolado tribes_partner_test.");
  const admin = new pg.Pool({ connectionString: databaseUrl });
  const schema = `partner_resources_${randomUUID().replaceAll("-", "")}`;
  await admin.query(`CREATE SCHEMA ${schema}`);
  const pool = new pg.Pool({ connectionString: databaseUrl, options: `-c search_path=${schema}`, max: 24 });
  t.after(async () => { await pool.end(); await admin.query(`DROP SCHEMA ${schema} CASCADE`); await admin.end(); });
  for (const file of (await readdir(migrations)).filter(name => name.endsWith(".sql")).sort()) {
    await pool.query(await readFile(new URL(file, migrations), "utf8"));
  }

  const store = createPartnerStore(pool);
  const marker = randomUUID();
  const partner = await store.createPartner({ slug: `res-${marker.slice(0, 8)}`, name: "Resource partner" });
  const otherPartner = await store.createPartner({ slug: `oth-${marker.slice(0, 8)}`, name: "Other resource partner" });
  const scopes = ["events:read", "events:write", "organizers:write"];
  const app = await store.createApplication({ partnerId: partner.id, slug: "primary", name: "Primary app", scopes });
  const otherApp = await store.createApplication({ partnerId: partner.id, slug: "secondary", name: "Secondary app", scopes });
  const otherPartnerApp = await store.createApplication({ partnerId: otherPartner.id, slug: "primary", name: "Other app", scopes });
  const key = await store.issueKey({ applicationId: app.id, label: "Primary key", expiresAt: expiry() });
  const otherKey = await store.issueKey({ applicationId: otherApp.id, label: "Secondary key", expiresAt: expiry() });
  const otherPartnerKey = await store.issueKey({ applicationId: otherPartnerApp.id, label: "Other partner key", expiresAt: expiry() });

  const handler = createPartnerRequestHandler({ store });
  const server = createServer((request, response) => void handler(request, response, new URL(request.url, "http://localhost")));
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  t.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }));
  const origin = `http://127.0.0.1:${server.address().port}`;
  async function call(credential, path, { method = "GET", body } = {}) {
    const response = await fetch(`${origin}/api/v1/partners${path}`, {
      method,
      headers: { Authorization: `Bearer ${credential}`, ...(body === undefined ? {} : { "Content-Type": "application/json" }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    return { response, data: await response.json() };
  }
  const tribePayload = {
    externalTribeId: "managed-club", name: "Managed club", description: "A provisional community.",
    category: "Games", format: "Online", city: "Belo Horizonte", neighborhood: "",
  };
  const createdTribe = await call(key.apiKey, "/tribes", { method: "POST", body: tribePayload });
  assert.equal(createdTribe.response.status, 201, JSON.stringify(createdTribe.data));
  assert.equal(createdTribe.data.created, true);
  const concurrentTribeCreates = await Promise.all(Array.from({ length: 8 }, () => call(key.apiKey, "/tribes", { method: "POST", body: tribePayload })));
  assert.ok(concurrentTribeCreates.every(result => result.response.status === 200 && result.data.created === false));
  assert.ok(concurrentTribeCreates.every(result => result.data.tribe.id === createdTribe.data.tribe.id));
  assert.equal((await pool.query("SELECT count(*)::int AS count FROM partner_tribes WHERE partner_id = $1 AND application_id = $2 AND external_tribe_id = 'managed-club'", [partner.id, app.id])).rows[0].count, 1);
  assert.equal((await pool.query("SELECT count(*)::int AS count FROM partner_audit_logs WHERE action = 'tribe.created' AND resource_id = $1", [createdTribe.data.tribe.id])).rows[0].count, 1);
  assert.equal((await call(key.apiKey, "/tribes/managed-club")).data.tribe.linkedToSocialTribe, false);
  const repeatedTribe = await call(key.apiKey, "/tribes", { method: "POST", body: tribePayload });
  assert.equal(repeatedTribe.response.status, 200);
  assert.equal(repeatedTribe.data.tribe.id, createdTribe.data.tribe.id);
  assert.equal((await pool.query("SELECT count(*)::int AS count FROM users")).rows[0].count, 0);
  assert.equal((await call(key.apiKey, "/tribes", { method: "POST", body: { ...tribePayload, name: "Conflicting club" } })).response.status, 409);
  const updatedTribe = await call(key.apiKey, "/tribes/managed-club", { method: "PATCH", body: {
    name: "Managed club updated", description: "Updated provisional community.", category: "Games",
    format: "Online", city: "Belo Horizonte", neighborhood: "Central",
  } });
  assert.equal(updatedTribe.response.status, 200);
  assert.equal(updatedTribe.data.tribe.name, "Managed club updated");
  assert.equal((await call(key.apiKey, "/tribes/managed-club")).data.tribe.description, "Updated provisional community.");
  assert.equal((await call(otherKey.apiKey, "/tribes/managed-club")).response.status, 404);
  assert.equal((await call(key.apiKey, "/tribes", { method: "POST", body: { ...tribePayload, socialTribeId: randomUUID() } })).response.status, 400);

  const eventPayload = {
    externalEventId: "event-1", externalTribeId: "managed-club", title: "Game night", description: "Bring a game.",
    startsAt: "2030-02-01T19:00:00-03:00", endsAt: "2030-02-01T21:00:00-03:00", location: "Community room", cost: "Free", maxAttendees: 20,
  };
  const beforeSocialCounts = (await pool.query("SELECT (SELECT count(*) FROM feed_items)::int AS feed, (SELECT count(*) FROM tribe_events)::int AS events")).rows[0];
  const firstEvent = await call(key.apiKey, "/events", { method: "POST", body: eventPayload });
  assert.equal(firstEvent.response.status, 201, JSON.stringify(firstEvent.data));
  assert.equal(firstEvent.data.created, true);
  assert.equal(firstEvent.data.event.startsAt, "2030-02-01T22:00:00.000Z");
  const concurrent = await Promise.all(Array.from({ length: 10 }, () => call(key.apiKey, "/events", { method: "POST", body: eventPayload })));
  assert.ok(concurrent.every(result => result.response.status === 200), JSON.stringify(concurrent.map(result => result.data)));
  assert.ok(concurrent.every(result => result.data.event.id === firstEvent.data.event.id && result.data.created === false));
  assert.equal((await pool.query("SELECT count(*)::int AS count FROM partner_events WHERE partner_id = $1 AND external_event_id = 'event-1'", [partner.id])).rows[0].count, 1);
  await assert.rejects(pool.query("UPDATE partner_events SET location_lat = 10, location_lon = NULL WHERE id = $1", [firstEvent.data.event.id]), { code: "23514" });
  assert.equal((await pool.query("SELECT count(*)::int AS count FROM partner_audit_logs WHERE action = 'event.created' AND resource_id = $1", [firstEvent.data.event.id])).rows[0].count, 1);
  const normalizedReplay = await call(key.apiKey, "/events", { method: "POST", body: {
    ...eventPayload, startsAt: "2030-02-01T22:00:00.000Z", endsAt: "2030-02-02T00:00:00.000Z",
  } });
  assert.equal(normalizedReplay.response.status, 200);
  assert.equal(normalizedReplay.data.event.id, firstEvent.data.event.id);
  assert.equal((await pool.query("SELECT count(*)::int AS count FROM users")).rows[0].count, 0);
  assert.equal((await call(key.apiKey, "/events", { method: "POST", body: { ...eventPayload, title: "Different payload" } })).response.status, 409);
  assert.equal((await call(otherKey.apiKey, "/events/event-1")).response.status, 404);
  assert.equal((await call(otherKey.apiKey, "/tribes", { method: "POST", body: tribePayload })).response.status, 201);
  assert.equal((await call(otherKey.apiKey, "/events", { method: "POST", body: eventPayload })).response.status, 404);
  assert.equal((await call(otherKey.apiKey, "/events/event-1", { method: "PATCH", body: { ...eventPayload, externalEventId: undefined } })).response.status, 404);
  assert.equal((await call(otherPartnerKey.apiKey, "/tribes", { method: "POST", body: tribePayload })).response.status, 201);
  assert.equal((await call(otherPartnerKey.apiKey, "/events", { method: "POST", body: eventPayload })).response.status, 201);

  const gotEvent = await call(key.apiKey, "/events/event-1");
  assert.equal(gotEvent.response.status, 200);
  assert.equal(gotEvent.data.event.tribe.externalTribeId, "managed-club");
  const update = { ...eventPayload, title: "Game night updated", maxAttendees: 30 };
  delete update.externalEventId;
  const updated = await call(key.apiKey, "/events/event-1", { method: "PATCH", body: update });
  assert.equal(updated.response.status, 200, JSON.stringify(updated.data));
  assert.equal(updated.data.event.title, "Game night updated");
  assert.equal(updated.data.event.tribe.linkedToSocialTribe, false);
  assert.equal((await pool.query("SELECT count(*)::int AS count FROM partner_audit_logs WHERE action = 'event.updated' AND resource_id = $1", [firstEvent.data.event.id])).rows[0].count, 1);

  const afterSocialCounts = (await pool.query("SELECT (SELECT count(*) FROM feed_items)::int AS feed, (SELECT count(*) FROM tribe_events)::int AS events")).rows[0];
  assert.deepEqual(afterSocialCounts, beforeSocialCounts);
  const readOnlyKey = await store.issueKey({ applicationId: app.id, label: "Read only", scopes: ["events:read"], expiresAt: expiry() });
  assert.equal((await call(readOnlyKey.apiKey, "/events/event-1")).response.status, 200);
  assert.equal((await call(readOnlyKey.apiKey, "/events", { method: "POST", body: eventPayload })).response.status, 403);
});
