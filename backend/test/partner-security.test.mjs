import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { randomBytes, randomUUID } from "node:crypto";
import { createPartnerKey, digestPartnerKey, matchesPartnerKey, parsePartnerKey, partnerExpiry,
  partnerScopes, partnerSlug, readPartnerBearer } from "../partner-security.mjs";
import { createPartnerAuthLimiter, createPartnerRequestHandler } from "../partner-api.mjs";
import { runPartnerAdmin } from "../partner-admin.mjs";
import { parsePartnerEvent, parsePartnerParticipant, parsePartnerClaimToken, parsePartnerTribe } from "../partner-resources.mjs";

test("partner credentials are random, hashed and independent of session tokens", () => {
  const first = createPartnerKey();
  const second = createPartnerKey();
  assert.notEqual(first.id, second.id);
  assert.notEqual(first.token, second.token);
  assert.equal(first.tokenHash.length, 64);
  assert.notEqual(first.tokenHash, first.token);
  assert.equal(digestPartnerKey(first.token), first.tokenHash);
  assert.equal(matchesPartnerKey(first.token, first.tokenHash), true);
  assert.equal(matchesPartnerKey(second.token, first.tokenHash), false);
  assert.equal(matchesPartnerKey(first.token, "invalid"), false);
  assert.deepEqual(parsePartnerKey(first.token), { id: first.id });
  for (const invalid of [null, "a".repeat(43), first.token + "x", first.token.replace("tribes_pk_", ""), `${first.token.slice(0, -43)}${"_".repeat(43)}`]) assert.equal(parsePartnerKey(invalid), null);
  assert.equal(readPartnerBearer({ headers: { cookie: `tribes_session=${first.token}` } }), null);
  assert.equal(readPartnerBearer({ headers: { authorization: `Bearer ${first.token}` } }), first.token);
  assert.equal(readPartnerBearer({ headers: { authorization: `Basic ${first.token}` } }), null);
  assert.equal(readPartnerBearer({ headers: { authorization: `Bearer ${first.token} extra` } }), null);
});

test("partner provisioning validates scopes, slugs and expiration", () => {
  assert.deepEqual(partnerScopes(["organizer-grants:read", "status:read"]), ["organizer-grants:read", "status:read"]);
  assert.deepEqual(partnerScopes(["events:read", "status:read"]), ["events:read", "status:read"]);
  for (const invalid of [[], ["admin"], ["status:read", "status:read"], "status:read", null]) assert.throws(() => partnerScopes(invalid), { code: "invalid_payload" });
  for (const invalid of ["a", "Hello", "../partner", " a-good-slug "]) assert.throws(() => partnerSlug(invalid), { code: "invalid_payload" });
  for (const invalid of ["2020-01-01T00:00:00Z", "2090-02-30T00:00:00Z", "2090-01-01", "2090-01-01T00:00:00", "invalid"]) assert.throws(() => partnerExpiry(invalid), { code: "invalid_payload" });
  assert.equal(partnerExpiry("2090-01-01T12:00:00-03:00"), "2090-01-01T15:00:00.000Z");
});

test("partner resource payloads normalize dates and reject arbitrary social tribe references", () => {
  const tribe = parsePartnerTribe({ externalTribeId: "hobby-club", name: "Hobby club", description: "A partner-managed club.", category: "Games", format: "Online", city: "Belo Horizonte" }, { creating: true });
  assert.equal(tribe.neighborhood, "");
  assert.equal(tribe.externalTribeId, "hobby-club");
  assert.throws(() => parsePartnerTribe({ externalTribeId: "x", socialTribeId: randomUUID(), name: "Hobby club", description: "A partner-managed club.", category: "Games", format: "Online", city: "Belo Horizonte" }, { creating: true }), { code: "invalid_payload" });
  const event = parsePartnerEvent({ externalEventId: "evt-1", externalTribeId: "hobby-club", title: "Game night", description: "Bring a game.", startsAt: "2030-01-01T12:00:00-03:00", location: "Online room" }, { creating: true });
  assert.equal(event.startsAt, "2030-01-01T15:00:00.000Z");
  assert.equal(event.endsAt, null);
  const update = { ...event };
  delete update.externalEventId;
  for (const startsAt of ["2030-02-30T12:00:00Z", "2030-01-01T12:00:00", "invalid"]) {
    assert.throws(() => parsePartnerEvent({ ...update, startsAt }), { code: "invalid_payload" });
  }
});

test("partner participant claim secrets require canonical 256-bit base64url tokens", () => {
  const token = randomBytes(32).toString("base64url");
  assert.equal(parsePartnerClaimToken(token), token);
  assert.deepEqual(parsePartnerParticipant({ claimToken: token }), { claimToken: token });
  for (const invalid of ["short", `${token}=`, `${token.slice(0, -1)}.`, "A".repeat(42), "A".repeat(44)]) {
    assert.throws(() => parsePartnerClaimToken(invalid), { code: "invalid_payload" });
  }
  assert.throws(() => parsePartnerParticipant({ claimToken: token, email: "buyer@example.test" }), { code: "invalid_payload" });
});

test("invalid authentication limiter is bounded and expires", () => {
  let time = 1000;
  const limiter = createPartnerAuthLimiter({ now: () => time, maxEntries: 2, limit: 2 });
  assert.equal(limiter.blocked("a"), false);
  limiter.record("a"); limiter.record("a");
  assert.equal(limiter.blocked("a"), true);
  limiter.record("b");
  assert.equal(limiter.blocked("c"), true);
  time += 60001;
  assert.equal(limiter.blocked("a"), false);
  assert.equal(limiter.blocked("c"), false);
});

test("operational CLI rejects unknown, duplicated and missing options before writing", async () => {
  for (const args of [[], ["create-partner", "--token", "secret"], ["create-partner", "--name"], ["create-partner", "--name", "One", "--name", "Two"]]) {
    await assert.rejects(runPartnerAdmin(args, {}), { code: "invalid_payload" });
  }
  let received;
  const result = await runPartnerAdmin(["create-application", "--partner", randomUUID(), "--slug", "ticketing", "--name", "Ticketing", "--scopes", "status:read,events:read"], {
    async createApplication(values) { received = values; return { id: "result" }; },
  });
  assert.deepEqual(received.scopes, ["status:read", "events:read"]);
  assert.deepEqual(result, { application: { id: "result" } });
  await assert.rejects(runPartnerAdmin(["authorize-social-tribe", "--application", randomUUID(), "--tribe", randomUUID(), "--external-tribe-id", "club"], {}), { code: "invalid_payload" });
});

test("partner API fails closed and never logs credentials or database details", async () => {
  const key = createPartnerKey();
  const logs = [];
  const handler = createPartnerRequestHandler({
    store: { async withAuthorization() { throw new Error(`database detail ${key.token}`); } },
    logError: (...args) => logs.push(args),
  });
  let body;
  let status;
  const response = { setHeader() {}, writeHead(value) { status = value; }, end(value) { body = JSON.parse(value); } };
  const request = { headers: { authorization: `Bearer ${key.token}` }, socket: { remoteAddress: "127.0.0.1" }, method: "GET" };
  assert.equal(await handler(request, response, new URL("http://localhost/api/v1/partners/status")), true);
  assert.equal(status, 503);
  assert.equal(body.code, "partner_api_unavailable");
  assert.equal(JSON.stringify({ body, logs }).includes(key.token), false);
  assert.equal(await handler(request, response, new URL("http://localhost/api/auth/me")), false);
});

test("partner OpenAPI documents the implemented social request and retention contracts", async () => {
  const openapi = JSON.parse(await readFile(new URL("../partner-openapi.json", import.meta.url), "utf8"));
  const join = openapi.paths["/api/me/partner-participants/{participantId}/join-tribe"].post;
  assert.equal(join.requestBody.required, true, "join route parses and requires a JSON object, including an empty object");
  assert.ok(openapi.paths["/api/me/partner-participants"].get.responses["400"]);
  assert.ok(openapi.paths["/api/me/partner-participants/{participantId}"].delete.responses["400"]);
  assert.ok(openapi.paths["/api/v1/partners/events/{externalEventId}/participants/{externalParticipantId}"].delete.responses["400"]);
  assert.ok(openapi.components.schemas.Error.properties.code.enum.includes("event_schedule_locked"));
  for (const [path, method] of [
    ["/api/v1/partners/tribes", "post"],
    ["/api/v1/partners/tribes/{externalTribeId}", "patch"],
    ["/api/v1/partners/events", "post"],
    ["/api/v1/partners/events/{externalEventId}", "patch"],
    ["/api/v1/partners/events/{externalEventId}/participants/{externalParticipantId}", "post"],
    ["/api/v1/partners/events/{externalEventId}/participants/{externalParticipantId}/claim-token", "put"],
  ]) {
    assert.equal(openapi.paths[path][method].responses["413"].$ref, "#/components/responses/PayloadTooLarge");
  }
  assert.match(openapi.components.responses.PayloadTooLarge.description, /16 KiB/);
  for (const [path, method] of [
    ["/api/partner-participants/preview", "post"],
    ["/api/partner-participants/confirm", "post"],
    ["/api/me/partner-participants/{participantId}/join-tribe", "post"],
    ["/api/tribes/{tribeId}/partner-links/preview", "post"],
    ["/api/tribes/{tribeId}/partner-links/confirm", "post"],
    ["/api/tribes/{tribeId}/partner-grants", "post"],
  ]) {
    assert.equal(openapi.paths[path][method].responses["413"].$ref,
      "#/components/responses/SocialPayloadTooLarge");
  }
  assert.match(openapi.components.responses.SocialPayloadTooLarge.description, /invalid_payload/);
  assert.match(openapi.paths["/api/v1/partners/events/{externalEventId}/cancel"].post.responses["400"].description,
    /invalid_payload/);
  assert.match(openapi.paths["/api/me/partner-participants/{participantId}"].delete.description, /terminal/i);
  assert.match(openapi.components.securitySchemes.socialSession.description, /titularidade do ingresso/);
});
