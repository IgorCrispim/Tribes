import test from "node:test";
import assert from "node:assert/strict";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { once } from "node:events";
import { readFile, readdir } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { createPartnerStore } from "../partner-store.mjs";
import { createPartnerKey, PartnerError } from "../partner-security.mjs";
import { createSessionToken, digestSessionToken } from "../security.mjs";
import { createPartnerRequestHandler } from "../partner-api.mjs";

// Explicit opt-in, never implicitly use backend/.env or an application's DB.
const databaseUrl = process.env.TRIBES_PARTNER_TEST_DATABASE_URL;
const integrationTest = databaseUrl ? test : test.skip;
const runtimeRoleIntegrationTest = databaseUrl && process.env.DATABASE_RUNTIME_ROLE ? test : test.skip;

async function fixture(t) {
  assert.equal(new URL(databaseUrl).pathname, "/tribes_partner_test", "Use exclusivamente o banco isolado tribes_partner_test.");
  const admin = new pg.Pool({ connectionString: databaseUrl });
  const schema = `partner_test_${randomUUID().replaceAll("-", "")}`;
  await admin.query(`CREATE SCHEMA ${schema}`);
  const pool = new pg.Pool({ connectionString: databaseUrl, options: `-c search_path=${schema}`, max: 30 });
  t.after(async () => { await pool.end(); await admin.query(`DROP SCHEMA ${schema} CASCADE`); await admin.end(); });
  return { pool, store: createPartnerStore(pool), schema };
}

const migrations = new URL("../migrations/", import.meta.url);
const expiry = () => new Date(Date.now() + 86400000).toISOString();
const foundationFiles = ["1000_partner_foundation.sql", "1001_partner_audit_integrity.sql"];
const resourceMigrationFiles = ["1002_partner_resources.sql", "1003_partner_social_tribe_unlink.sql", "1004_partner_event_coordinates.sql", "1005_partner_social_link_consent.sql", "1006_partner_social_link_delete_audit.sql", "1007_partner_organizer_grants.sql", "1008_partner_event_participants.sql", "1009_partner_participant_secret_retention.sql", "1010_partner_event_retention_anchor.sql", "1011_partner_preview_secret_nullability.sql"];
const partnerMigrationFiles = [...foundationFiles, ...resourceMigrationFiles];
async function applyFoundation(pool) {
  for (const file of foundationFiles) await pool.query(await readFile(new URL(file, migrations), "utf8"));
}

runtimeRoleIntegrationTest("runtime tombstone access is non-owner INSERT-only and not enumerable", async t => {
  assert.equal(new URL(databaseUrl).pathname, "/tribes_partner_test", "Use exclusivamente o banco isolado tribes_partner_test.");
  const pool = new pg.Pool({ connectionString: databaseUrl });
  t.after(() => pool.end());
  const access = (await pool.query(`
    SELECT runtime_role.rolsuper,
           runtime_role.rolbypassrls,
           table_info.relowner = runtime_role.oid AS owns_table,
           pg_has_role(runtime_role.oid, table_info.relowner, 'MEMBER') AS can_assume_owner,
           EXISTS (
             SELECT 1 FROM pg_roles member_role
             WHERE member_role.oid <> runtime_role.oid
               AND pg_has_role(runtime_role.oid, member_role.oid, 'MEMBER')
           ) AS has_role_memberships,
           has_table_privilege(runtime_role.oid, table_info.oid, 'SELECT') AS can_select,
           has_table_privilege(runtime_role.oid, table_info.oid, 'INSERT') AS can_insert,
           has_table_privilege(runtime_role.oid, table_info.oid, 'UPDATE') AS can_update,
           has_table_privilege(runtime_role.oid, table_info.oid, 'DELETE') AS can_delete,
           has_table_privilege(runtime_role.oid, table_info.oid, 'TRUNCATE') AS can_truncate,
           has_table_privilege(runtime_role.oid, table_info.oid, 'REFERENCES') AS can_reference,
           has_table_privilege(runtime_role.oid, table_info.oid, 'TRIGGER') AS can_trigger,
           EXISTS (
             SELECT 1 FROM aclexplode(COALESCE(
               table_info.relacl, acldefault('r', table_info.relowner)
             )) acl WHERE acl.grantee = 0
           ) AS public_access,
           has_function_privilege(runtime_role.oid, runtime_function.oid, 'EXECUTE') AS can_execute,
           EXISTS (
             SELECT 1 FROM aclexplode(COALESCE(
               runtime_function.proacl, acldefault('f', runtime_function.proowner)
             )) acl WHERE acl.grantee = 0 AND acl.privilege_type = 'EXECUTE'
           ) AS public_function_access
    FROM pg_roles runtime_role
    JOIN pg_class table_info ON table_info.oid = 'public.partner_event_participant_claim_token_hashes'::regclass
    JOIN pg_proc runtime_function
      ON runtime_function.pronamespace = table_info.relnamespace
     AND runtime_function.proname = 'record_partner_participant_claim_token_hash'
     AND runtime_function.pronargs = 3
    WHERE runtime_role.rolname = $1`, [process.env.DATABASE_RUNTIME_ROLE])).rows[0];
  assert.ok(access, "the configured runtime role and tombstone table exist after backend migrations");
  assert.equal(access.rolsuper, false);
  assert.equal(access.rolbypassrls, false);
  assert.equal(access.owns_table, false);
  assert.equal(access.can_assume_owner, false);
  assert.equal(access.has_role_memberships, false);
  assert.equal(access.can_execute, true);
  assert.equal(access.public_function_access, false);
  for (const privilege of ["can_select", "can_insert", "can_update", "can_delete", "can_truncate", "can_reference", "can_trigger", "public_access"]) {
    assert.equal(access[privilege], false, `${privilege} must be denied`);
  }
});

integrationTest("foundation migration preserves existing social records and supports clean installation", async t => {
  const { pool } = await fixture(t);
  const files = (await readdir(migrations)).filter(name => name.endsWith(".sql")).sort();
  for (const file of files.filter(name => !partnerMigrationFiles.includes(name))) await pool.query(await readFile(new URL(file, migrations), "utf8"));
  const user = (await pool.query("INSERT INTO users (display_name, email, password_hash) VALUES ('Existing user', 'existing@example.test', 'preserved-hash') RETURNING *")).rows[0];
  const tribe = (await pool.query("INSERT INTO tribes (name, description, category, format, city, created_by, moderator_id) VALUES ('Existing tribe', 'Existing community', 'Games', 'Online', 'Belo Horizonte', $1, $1) RETURNING *", [user.id])).rows[0];
  await pool.query("INSERT INTO tribe_memberships (tribe_id, user_id) VALUES ($1, $2)", [tribe.id, user.id]);
  const before = (await pool.query("SELECT row_to_json(m) AS data FROM tribe_memberships m")).rows;
  await applyFoundation(pool);
  assert.deepEqual((await pool.query("SELECT * FROM users WHERE id = $1", [user.id])).rows[0], user);
  assert.deepEqual((await pool.query("SELECT * FROM tribes WHERE id = $1", [tribe.id])).rows[0], tribe);
  assert.deepEqual((await pool.query("SELECT row_to_json(m) AS data FROM tribe_memberships m")).rows, before);
  for (const file of resourceMigrationFiles) await pool.query(await readFile(new URL(file, migrations), "utf8"));
  assert.equal((await pool.query("SELECT count(*)::int AS count FROM partner_events")).rows[0].count, 0);
  const clean = await fixture(t);
  for (const file of files) await clean.pool.query(await readFile(new URL(file, migrations), "utf8"));
  assert.equal((await clean.pool.query("SELECT count(*)::int AS count FROM users")).rows[0].count, 0);
});

integrationTest("consent migration refuses to bless a legacy social link without moderator evidence", async t => {
  const { pool } = await fixture(t);
  const files = (await readdir(migrations)).filter(name => name.endsWith(".sql") &&
    !["1005_partner_social_link_consent.sql", "1006_partner_social_link_delete_audit.sql", "1008_partner_event_participants.sql", "1009_partner_participant_secret_retention.sql", "1010_partner_event_retention_anchor.sql", "1011_partner_preview_secret_nullability.sql"].includes(name)).sort();
  for (const file of files) await pool.query(await readFile(new URL(file, migrations), "utf8"));
  const user = (await pool.query(
    "INSERT INTO users (display_name, email, password_hash) VALUES ('Legacy moderator', 'legacy-link@example.test', 'test-only') RETURNING id")).rows[0];
  const socialTribe = (await pool.query(
    `INSERT INTO tribes (name, description, category, format, city, created_by, moderator_id)
     VALUES ('Legacy tribe', 'Legacy community.', 'Games', 'Online', 'Belo Horizonte', $1, $1) RETURNING id`, [user.id])).rows[0];
  const partner = (await pool.query("INSERT INTO partners (slug, name) VALUES ('legacy-link-company', 'Legacy link company') RETURNING id")).rows[0];
  const app = (await pool.query(
    "INSERT INTO partner_applications (partner_id, slug, name, scopes) VALUES ($1, 'legacy-app', 'Legacy app', ARRAY['organizers:write']) RETURNING id",
    [partner.id])).rows[0];
  await pool.query(
    `INSERT INTO partner_tribes (partner_id, application_id, external_tribe_id, social_tribe_id, name, description, category, format, city)
     VALUES ($1, $2, 'legacy-external', $3, 'Legacy tribe', 'Legacy community.', 'Games', 'Online', 'Belo Horizonte')`,
    [partner.id, app.id, socialTribe.id]);
  await assert.rejects(
    pool.query(await readFile(new URL("1005_partner_social_link_consent.sql", migrations), "utf8")),
    { code: "P0001" },
  );
  assert.equal((await pool.query("SELECT to_regclass('partner_social_tribe_link_history') AS table_name")).rows[0].table_name, null);
});

integrationTest("migrations 1009/1010 upgrade populated participant data and roll back atomically", async t => {
  const { pool } = await fixture(t);
  const files = (await readdir(migrations)).filter(name => name.endsWith(".sql") &&
    !["1009_partner_participant_secret_retention.sql", "1010_partner_event_retention_anchor.sql", "1011_partner_preview_secret_nullability.sql"].includes(name)).sort();
  for (const file of files) await pool.query(await readFile(new URL(file, migrations), "utf8"));

  const marker = randomUUID();
  const userId = (await pool.query(
    "INSERT INTO users (display_name, email, password_hash) VALUES ('Migration claim owner', $1, 'test-only') RETURNING id",
    [`${marker}@example.test`])).rows[0].id;
  const socialTribeId = (await pool.query(
    `INSERT INTO tribes (name, description, category, format, city, created_by, moderator_id)
     VALUES ('Migration tribe', 'Migration fixture.', 'Games', 'Online', 'Belo Horizonte', $1, $1) RETURNING id`,
    [userId])).rows[0].id;
  const partnerId = (await pool.query(
    "INSERT INTO partners (slug, name) VALUES ($1, 'Migration partner') RETURNING id",
    [`mig-${marker.slice(0, 8)}`])).rows[0].id;
  const applicationId = (await pool.query(
    `INSERT INTO partner_applications (partner_id, slug, name, scopes)
     VALUES ($1, 'migration', 'Migration app', ARRAY['events:write', 'participants:write']) RETURNING id`,
    [partnerId])).rows[0].id;
  const partnerTribeId = (await pool.query(
    `INSERT INTO partner_tribes
       (partner_id, application_id, external_tribe_id, social_tribe_id, name, description, category, format, city)
     VALUES ($1, $2, $3, $4, 'Migration club', 'Migration fixture club.', 'Games', 'Online', 'Belo Horizonte')
     RETURNING id`, [partnerId, applicationId, `club-${marker}`, socialTribeId])).rows[0].id;
  const linkId = (await pool.query(
    `INSERT INTO partner_social_tribe_link_history
       (partner_id, application_id, partner_tribe_id, social_tribe_id_snapshot, authorized_by,
        private_at_authorization, private_data_consent)
     VALUES ($1, $2, $3, $4, $5, FALSE, FALSE) RETURNING id`,
    [partnerId, applicationId, partnerTribeId, socialTribeId, userId])).rows[0].id;
  const eventId = (await pool.query(
    `INSERT INTO partner_events
       (partner_id, application_id, partner_tribe_id, external_event_id, title, description,
        starts_at, ends_at, location)
     VALUES ($1, $2, $3, $4, 'Migration event', 'Migration fixture event.',
             clock_timestamp() + INTERVAL '1 day', clock_timestamp() + INTERVAL '1 day 2 hours', 'Online')
     RETURNING id`, [partnerId, applicationId, partnerTribeId, `event-${marker}`])).rows[0].id;
  const participantId = randomUUID();
  const consumedPreviewId = randomUUID();
  const pendingPreviewId = randomUUID();
  await pool.query(
    `INSERT INTO partner_event_participants
       (id, partner_id, application_id, partner_event_id, external_participant_id,
        claim_token_hash, claim_expires_at, claim_token_used_at, claimed_user_id, claimed_at,
        claimed_social_link_id, claimed_social_tribe_id_snapshot, claimed_social_tribe_name_snapshot,
        confirmed_preview_id)
     VALUES ($1, $2, $3, $4, 'migrated-ticket', NULL, clock_timestamp() + INTERVAL '1 day',
             clock_timestamp(), $5, clock_timestamp(), $6, $7, 'Migration tribe', $8)`,
    [participantId, partnerId, applicationId, eventId, userId, linkId, socialTribeId, consumedPreviewId]);
  const previewFields = [
    participantId, userId, linkId, socialTribeId,
    new Date(Date.now() - 1000), "Migration event", "Migration tribe", false,
  ];
  const consumedConfirmationToken = randomBytes(32).toString("base64url");
  const consumedTokenHash = createHash("sha256").update(consumedConfirmationToken).digest("hex");
  const pendingTokenHash = createHash("sha256").update(randomBytes(32)).digest("hex");
  await pool.query(
    `INSERT INTO partner_event_participant_previews
       (id, confirmation_token_hash, participant_id, requested_by, partner_social_link_id,
        social_tribe_id_snapshot, partner_event_updated_at_snapshot, partner_event_title_snapshot,
        social_tribe_name_snapshot, social_tribe_private_snapshot, expires_at, consumed_at, confirmed_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, clock_timestamp() + INTERVAL '4 minutes', clock_timestamp(), $4)`,
    [consumedPreviewId, consumedTokenHash, ...previewFields]);
  await pool.query(
    `INSERT INTO partner_event_participant_previews
       (id, confirmation_token_hash, participant_id, requested_by, partner_social_link_id,
        social_tribe_id_snapshot, partner_event_updated_at_snapshot, partner_event_title_snapshot,
        social_tribe_name_snapshot, social_tribe_private_snapshot, expires_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, clock_timestamp() + INTERVAL '4 minutes')`,
    [pendingPreviewId, pendingTokenHash, ...previewFields]);

  const migrationSql = await readFile(new URL("1009_partner_participant_secret_retention.sql", migrations), "utf8");
  await pool.query("CREATE TABLE partner_event_participant_audit_aggregates (migration_failure_fixture BOOLEAN)");
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await assert.rejects(client.query(migrationSql), { code: "42P07" });
    await client.query("ROLLBACK");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
  assert.equal((await pool.query(
    "SELECT count(*)::int AS count FROM partner_event_participant_previews WHERE id = $1", [pendingPreviewId])).rows[0].count, 1,
  "an unconsumed preview deletion is rolled back when the migration fails later");
  assert.equal((await pool.query(
    "SELECT count(*)::int AS count FROM information_schema.columns WHERE table_schema = current_schema() AND table_name = 'partner_event_participants' AND column_name = 'claim_token_version'",
  )).rows[0].count, 0, "schema alterations are rolled back with the failed migration");
  await pool.query("DROP TABLE partner_event_participant_audit_aggregates");

  const upgradeClient = await pool.connect();
  try {
    await upgradeClient.query("BEGIN");
    await upgradeClient.query(migrationSql);
    await upgradeClient.query("COMMIT");
  } catch (error) {
    await upgradeClient.query("ROLLBACK");
    throw error;
  } finally {
    upgradeClient.release();
  }
  const upgradedPreview = (await pool.query(
    `SELECT consumed_at, confirmed_by, claim_token_version, claim_token_hash
     FROM partner_event_participant_previews WHERE id = $1`, [consumedPreviewId])).rows[0];
  assert.ok(upgradedPreview.consumed_at);
  assert.equal(upgradedPreview.confirmed_by, userId);
  assert.equal(upgradedPreview.claim_token_version, "1");
  assert.equal(upgradedPreview.claim_token_hash, null,
    "a consumed preview with an already-cleared secret remains idempotent without inventing a hash");
  assert.equal((await pool.query(
    "SELECT count(*)::int AS count FROM partner_event_participant_claim_token_hashes WHERE participant_id = $1",
    [participantId])).rows[0].count, 0, "the upgrade does not synthesize a tombstone for an unavailable legacy secret");
  assert.equal((await pool.query(
    "SELECT count(*)::int AS count FROM partner_event_participant_previews WHERE id = $1", [pendingPreviewId])).rows[0].count, 0);

  const sessionToken = createSessionToken();
  await pool.query(
    "INSERT INTO user_sessions (token_hash, user_id, expires_at) VALUES ($1, $2, clock_timestamp() + INTERVAL '1 day')",
    [digestSessionToken(sessionToken), userId]);
  const repeatedConfirmation = await createPartnerStore(pool).confirmPartnerEventParticipantClaim({
    sessionToken, userId, rawConfirmationToken: consumedConfirmationToken,
  });
  assert.equal(repeatedConfirmation.participant.id, participantId);
  assert.equal(repeatedConfirmation.linked, true);

  await pool.query(
    `UPDATE partner_events
     SET starts_at = clock_timestamp() - INTERVAL '11 days',
         ends_at = clock_timestamp() - INTERVAL '10 days'
     WHERE id = $1`, [eventId]);
  const anchorMigration = await readFile(new URL("1010_partner_event_retention_anchor.sql", migrations), "utf8");
  const anchorClient = await pool.connect();
  try {
    await anchorClient.query("BEGIN");
    await anchorClient.query(anchorMigration);
    await anchorClient.query("COMMIT");
  } catch (error) {
    await anchorClient.query("ROLLBACK");
    throw error;
  } finally {
    anchorClient.release();
  }
  const backfilledAnchor = (await pool.query(
    "SELECT participant_retention_at, ends_at FROM partner_events WHERE id = $1", [eventId])).rows[0];
  assert.equal(backfilledAnchor.participant_retention_at.getTime(), backfilledAnchor.ends_at.getTime(),
    "the upgrade anchors already-ended populated events to their scheduled end");
  await assert.rejects(
    pool.query("UPDATE partner_events SET ends_at = clock_timestamp() + INTERVAL '20 days' WHERE id = $1", [eventId]),
    error => error.code === "23514" && error.constraint === "partner_event_retention_schedule_immutable",
    "the installed database trigger freezes populated event dates after terminalization",
  );
});

integrationTest("1011 repairs a populated database that recorded the strict 1009 preview-hash constraint", async t => {
  const { pool } = await fixture(t);
  const files = (await readdir(migrations)).filter(name => name.endsWith(".sql") &&
    !["1009_partner_participant_secret_retention.sql", "1010_partner_event_retention_anchor.sql", "1011_partner_preview_secret_nullability.sql"].includes(name)).sort();
  for (const file of files) await pool.query(await readFile(new URL(file, migrations), "utf8"));

  const marker = randomUUID();
  const userId = (await pool.query(
    "INSERT INTO users (display_name, email, password_hash) VALUES ('Legacy preview owner', $1, 'test-only') RETURNING id",
    [`${marker}@example.test`])).rows[0].id;
  const socialTribeId = (await pool.query(
    `INSERT INTO tribes (name, description, category, format, city, created_by, moderator_id)
     VALUES ('Legacy preview tribe', 'Migration fixture.', 'Games', 'Online', 'Belo Horizonte', $1, $1) RETURNING id`,
    [userId])).rows[0].id;
  const partnerId = (await pool.query(
    "INSERT INTO partners (slug, name) VALUES ($1, 'Legacy preview partner') RETURNING id",
    [`old1009-${marker.slice(0, 8)}`])).rows[0].id;
  const applicationId = (await pool.query(
    `INSERT INTO partner_applications (partner_id, slug, name, scopes)
     VALUES ($1, 'legacy', 'Legacy preview app', ARRAY['events:write', 'participants:write']) RETURNING id`,
    [partnerId])).rows[0].id;
  const partnerTribeId = (await pool.query(
    `INSERT INTO partner_tribes
       (partner_id, application_id, external_tribe_id, social_tribe_id, name, description, category, format, city)
     VALUES ($1, $2, $3, $4, 'Legacy preview tribe', 'Migration fixture.', 'Games', 'Online', 'Belo Horizonte') RETURNING id`,
    [partnerId, applicationId, `legacy-${marker}`, socialTribeId])).rows[0].id;
  const linkId = (await pool.query(
    `INSERT INTO partner_social_tribe_link_history
       (partner_id, application_id, partner_tribe_id, social_tribe_id_snapshot, authorized_by,
        private_at_authorization, private_data_consent)
     VALUES ($1, $2, $3, $4, $5, FALSE, FALSE) RETURNING id`,
    [partnerId, applicationId, partnerTribeId, socialTribeId, userId])).rows[0].id;
  const eventId = (await pool.query(
    `INSERT INTO partner_events
       (partner_id, application_id, partner_tribe_id, external_event_id, title, description,
        starts_at, ends_at, location)
     VALUES ($1, $2, $3, $4, 'Legacy event', 'Migration fixture.',
             clock_timestamp() + INTERVAL '1 day', clock_timestamp() + INTERVAL '1 day 2 hours', 'Online') RETURNING id`,
    [partnerId, applicationId, partnerTribeId, `event-${marker}`])).rows[0].id;

  const participantId = randomUUID();
  const previewId = randomUUID();
  const rawClaimToken = randomBytes(32).toString("base64url");
  const legacyClaimHash = createHash("sha256").update(rawClaimToken).digest("hex");
  const rawConfirmationToken = randomBytes(32).toString("base64url");
  const legacyConfirmationHash = createHash("sha256").update(rawConfirmationToken).digest("hex");
  await pool.query(
    `INSERT INTO partner_event_participants
       (id, partner_id, application_id, partner_event_id, external_participant_id,
        claim_token_hash, claim_expires_at, claim_token_used_at, claimed_user_id, claimed_at,
        claimed_social_link_id, claimed_social_tribe_id_snapshot, claimed_social_tribe_name_snapshot,
        confirmed_preview_id)
     VALUES ($1, $2, $3, $4, 'legacy-ticket', $5, clock_timestamp() + INTERVAL '1 day',
             clock_timestamp(), $6, clock_timestamp(), $7, $8, 'Legacy preview tribe', $9)`,
    [participantId, partnerId, applicationId, eventId, legacyClaimHash, userId, linkId, socialTribeId, previewId]);
  await pool.query(
    `INSERT INTO partner_event_participant_previews
       (id, confirmation_token_hash, participant_id, requested_by, partner_social_link_id,
        social_tribe_id_snapshot, partner_event_updated_at_snapshot, partner_event_title_snapshot,
        social_tribe_name_snapshot, social_tribe_private_snapshot, expires_at, consumed_at, confirmed_by)
     VALUES ($1, $2, $3, $4, $5, $6, clock_timestamp(), 'Legacy event', 'Legacy preview tribe', FALSE,
             clock_timestamp() + INTERVAL '4 minutes', clock_timestamp(), $4)`,
    [previewId, legacyConfirmationHash, participantId, userId, linkId, socialTribeId]);

  await pool.query(await readFile(new URL("1009_partner_participant_secret_retention.sql", migrations), "utf8"));
  await pool.query(await readFile(new URL("1010_partner_event_retention_anchor.sql", migrations), "utf8"));

  // Model a database whose older 1009 required a hash even on consumed previews.
  // All populated legacy values remain present; 1011 must only relax the schema.
  await pool.query(
    `ALTER TABLE partner_event_participant_previews
       DROP CONSTRAINT partner_participant_preview_secret_hash_required_check,
       ALTER COLUMN claim_token_hash SET NOT NULL,
       ADD CONSTRAINT old_1009_preview_hash_required CHECK (claim_token_hash IS NOT NULL)`);
  await pool.query("GRANT SELECT ON partner_event_participant_claim_token_hashes TO PUBLIC");
  await pool.query(`CREATE TABLE schema_migrations (name TEXT PRIMARY KEY, applied_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP)`);
  await pool.query(
    "INSERT INTO schema_migrations (name) VALUES ('1009_partner_participant_secret_retention.sql'), ('1010_partner_event_retention_anchor.sql')");

  const migrationSql = await readFile(new URL("1011_partner_preview_secret_nullability.sql", migrations), "utf8");
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(migrationSql);
    await client.query("INSERT INTO schema_migrations (name) VALUES ('1011_partner_preview_secret_nullability.sql')");
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }

  const unchangedPreview = (await pool.query(
    "SELECT claim_token_hash FROM partner_event_participant_previews WHERE id = $1", [previewId])).rows[0];
  assert.equal(unchangedPreview.claim_token_hash, legacyClaimHash,
    "the forward migration preserves existing stored hashes");
  assert.equal((await pool.query(
    "SELECT token_hash FROM partner_event_participant_claim_token_hashes WHERE participant_id = $1", [participantId])).rows[0].token_hash,
  legacyClaimHash, "the existing global tombstone is not changed");
  assert.equal((await pool.query(
    `SELECT is_nullable FROM information_schema.columns
     WHERE table_schema = current_schema() AND table_name = 'partner_event_participant_previews'
       AND column_name = 'claim_token_hash'`)).rows[0].is_nullable, "YES");
  assert.equal((await pool.query(
    `SELECT count(*)::int AS count
     FROM pg_class table_info
     CROSS JOIN LATERAL aclexplode(COALESCE(
       table_info.relacl, acldefault('r', table_info.relowner)
     )) acl
     WHERE table_info.oid = 'partner_event_participant_claim_token_hashes'::regclass
       AND acl.grantee = 0`)).rows[0].count, 0,
  "the forward migration removes direct tombstone-table privileges from PUBLIC");

  // Running the incremental migration again has the same outcome.
  await pool.query(migrationSql);
  const nullableConsumedPreview = await pool.query(
    `INSERT INTO partner_event_participant_previews
       (confirmation_token_hash, participant_id, requested_by, partner_social_link_id,
        social_tribe_id_snapshot, partner_event_updated_at_snapshot, partner_event_title_snapshot,
        social_tribe_name_snapshot, social_tribe_private_snapshot, expires_at,
        claim_token_version, claim_token_hash, consumed_at, confirmed_by)
     VALUES ($1, $2, $3, $4, $5, clock_timestamp(), 'Legacy event', 'Legacy preview tribe', FALSE,
             clock_timestamp() + INTERVAL '4 minutes', 1, NULL, clock_timestamp(), $3)`,
    [createHash("sha256").update(randomBytes(32)).digest("hex"), participantId, userId, linkId, socialTribeId]);
  assert.equal(nullableConsumedPreview.rowCount, 1);
  await assert.rejects(
    pool.query(
      `INSERT INTO partner_event_participant_previews
         (confirmation_token_hash, participant_id, requested_by, partner_social_link_id,
          social_tribe_id_snapshot, partner_event_updated_at_snapshot, partner_event_title_snapshot,
          social_tribe_name_snapshot, social_tribe_private_snapshot, expires_at,
          claim_token_version, claim_token_hash)
       VALUES ($1, $2, $3, $4, $5, clock_timestamp(), 'Legacy event', 'Legacy preview tribe', FALSE,
               clock_timestamp() + INTERVAL '4 minutes', 1, NULL)`,
      [createHash("sha256").update(randomBytes(32)).digest("hex"), participantId, userId, linkId, socialTribeId]),
    { code: "23514" },
    "an unconsumed preview must still retain its participant secret hash",
  );
});

integrationTest("partner foundation enforces credentials, tenant integrity, scopes, concurrency and revocation", async t => {
  const { pool, store } = await fixture(t);
  await applyFoundation(pool);
  const creations = await Promise.all(Array.from({ length: 8 }, () => store.createPartner({ slug: "ticket-company", name: "Ticket company" })));
  assert.equal(new Set(creations.map(partner => partner.id)).size, 1);
  const partner = creations[0];
  const other = await store.createPartner({ slug: "other-company", name: "Other company" });
  await assert.rejects(store.createPartner({ slug: partner.slug, name: "Different name" }), { statusCode: 409 });
  const apps = await Promise.all(Array.from({ length: 8 }, () => store.createApplication({ partnerId: partner.id, slug: "ticketing", name: "Ticketing", scopes: ["status:read", "events:read"] })));
  assert.equal(new Set(apps.map(app => app.id)).size, 1);
  const app = apps[0];
  const otherApp = await store.createApplication({ partnerId: other.id, slug: "ticketing", name: "Other ticketing", scopes: ["status:read"] });
  await assert.rejects(store.createApplication({ partnerId: partner.id, slug: app.slug, name: app.name, scopes: ["status:read"] }), { statusCode: 409 });
  await assert.rejects(store.issueKey({ applicationId: app.id, label: "Excessive key", scopes: ["events:write"], expiresAt: expiry() }), { statusCode: 400 });
  const issued = await store.issueKey({ applicationId: app.id, label: "Production integration", expiresAt: expiry() });
  const otherKey = await store.issueKey({ applicationId: otherApp.id, label: "Other integration", expiresAt: expiry() });
  const saved = (await pool.query("SELECT * FROM partner_api_keys WHERE id = $1", [issued.credential.id])).rows[0];
  assert.notEqual(saved.token_hash, issued.apiKey);
  assert.equal(JSON.stringify(saved).includes(issued.apiKey), false);
  await assert.rejects(pool.query("UPDATE partner_api_keys SET partner_id = $2 WHERE id = $1", [issued.credential.id, other.id]), { code: "23503" });
  await assert.rejects(pool.query("UPDATE partner_applications SET scopes = ARRAY['global:admin'] WHERE id = $1", [app.id]), { code: "23514" });
  await assert.rejects(pool.query("DELETE FROM partners WHERE id = $1", [partner.id]), { code: "23503" });
  await assert.rejects(pool.query("INSERT INTO partner_audit_logs (partner_id, application_id, credential_id, action, resource_id) VALUES ($1, $2, $3, 'invalid.audit', $3)", [other.id, otherApp.id, issued.credential.id]), { code: "23503" });

  const handler = createPartnerRequestHandler({ store });
  const server = createServer((request, response) => void handler(request, response, new URL(request.url, "http://localhost")));
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  t.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }));
  const origin = `http://127.0.0.1:${server.address().port}`;
  async function call(key, path = "/api/v1/partners/status", options = {}) {
    const response = await fetch(`${origin}${path}`, { ...options, headers: { ...(key ? { Authorization: `Bearer ${key}` } : {}), ...options.headers } });
    return { response, data: await response.json() };
  }
  const status = await call(issued.apiKey);
  assert.equal(status.response.status, 200);
  assert.equal(status.data.partner.id, partner.id);
  assert.equal(status.data.application.id, app.id);
  assert.deepEqual(status.data.scopes, ["events:read", "status:read"]);
  assert.equal(status.response.headers.get("cache-control"), "no-store");
  assert.match(status.response.headers.get("x-request-id"), /^[0-9a-f-]{36}$/);
  assert.equal(JSON.stringify(status.data).includes(saved.token_hash), false);
  assert.equal((await call(otherKey.apiKey)).data.partner.id, other.id);
  assert.equal((await call(issued.apiKey, `/api/v1/partners/status?partnerId=${other.id}`)).response.status, 400);
  assert.equal((await call(null, undefined, { headers: { Cookie: `tribes_session=${issued.apiKey}` } })).response.status, 401);
  assert.equal((await call(createPartnerKey().token)).response.status, 401);
  assert.equal((await call(`${issued.apiKey.slice(0, -1)}${issued.apiKey.endsWith("A") ? "Q" : "A"}`)).response.status, 401);
  assert.equal((await call(issued.apiKey, undefined, { headers: { Origin: "https://partner.example" } })).response.status, 403);
  assert.equal((await call(issued.apiKey, undefined, { method: "POST" })).response.status, 405);
  assert.equal((await call(issued.apiKey, "/api/v1/partners/unknown")).response.status, 404);
  const narrow = await store.issueKey({ applicationId: app.id, label: "Read events only", scopes: ["events:read"], expiresAt: expiry() });
  assert.equal((await call(narrow.apiKey)).response.status, 403);
  await pool.query("UPDATE partner_applications SET scopes = ARRAY['events:read'] WHERE id = $1", [app.id]);
  assert.equal((await call(issued.apiKey)).response.status, 403);
  await pool.query("UPDATE partner_applications SET scopes = ARRAY['events:read','status:read'] WHERE id = $1", [app.id]);
  await store.setStatus("application", app.id, "disabled");
  assert.equal((await call(issued.apiKey)).response.status, 401);
  assert.equal((await call(otherKey.apiKey)).response.status, 200);
  await store.setStatus("application", app.id, "active");
  await store.setStatus("partner", partner.id, "disabled");
  assert.equal((await call(issued.apiKey)).response.status, 401);
  await store.setStatus("partner", partner.id, "active");
  const expired = await store.issueKey({ applicationId: app.id, label: "Expired key", expiresAt: expiry() });
  await pool.query("UPDATE partner_api_keys SET created_at = clock_timestamp() - INTERVAL '2 days', expires_at = clock_timestamp() - INTERVAL '1 day' WHERE id = $1", [expired.credential.id]);
  assert.equal((await call(expired.apiKey)).response.status, 401);

  // A revocation must wait for the authorized transaction, then prevent the next one.
  let entered;
  let release;
  const inside = new Promise(resolve => { entered = resolve; });
  const barrier = new Promise(resolve => { release = resolve; });
  const inFlight = store.withAuthorization(issued.apiKey, ["status:read"], async () => { entered(); await barrier; return true; });
  await inside;
  const revoking = store.revokeKey(issued.credential.id);
  const revocationState = await Promise.race([revoking.then(() => "revoked"), new Promise(resolve => setTimeout(() => resolve("waiting"), 50))]);
  assert.equal(revocationState, "waiting");
  release(); await inFlight;
  const revoked = await revoking;
  assert.equal((await call(issued.apiKey)).response.status, 401);
  assert.deepEqual(await store.revokeKey(issued.credential.id), revoked);
  assert.equal((await pool.query("SELECT count(*)::int AS count FROM partner_audit_logs WHERE action = 'credential.revoked' AND credential_id = $1", [issued.credential.id])).rows[0].count, 1);

  const rotations = await Promise.allSettled([store.rotateKey(otherKey.credential.id, expiry()), store.rotateKey(otherKey.credential.id, expiry())]);
  assert.equal(rotations.filter(result => result.status === "fulfilled").length, 1);
  assert.equal(rotations.filter(result => result.status === "rejected" && result.reason.statusCode === 409).length, 1);
  const rotated = rotations.find(result => result.status === "fulfilled").value;
  assert.equal((await call(otherKey.apiKey)).response.status, 401);
  assert.equal((await call(rotated.apiKey)).response.status, 200);

  // Two pools/keys emulate independent replicas. The limit must remain global.
  const limitedApp = await store.createApplication({ partnerId: other.id, slug: "limited", name: "Limited integration", scopes: ["status:read"], requestsPerMinute: 3 });
  const limitedKeys = await Promise.all([1, 2].map(number => store.issueKey({ applicationId: limitedApp.id, label: `Limited key ${number}`, expiresAt: expiry() })));
  const secondPool = new pg.Pool({ connectionString: databaseUrl, options: `-c search_path=${(await pool.query("SELECT current_schema() AS schema")).rows[0].schema}` });
  t.after(() => secondPool.end());
  const stores = [store, createPartnerStore(secondPool)];
  const concurrent = await Promise.allSettled(Array.from({ length: 12 }, (_, index) => stores[index % 2].withAuthorization(limitedKeys[index % 2].apiKey, ["status:read"], async () => true)));
  assert.equal(concurrent.filter(result => result.status === "fulfilled").length, 3);
  assert.equal(concurrent.filter(result => result.status === "rejected" && result.reason.statusCode === 429).length, 9);
  const limitedResponse = await call(limitedKeys[0].apiKey);
  assert.equal(limitedResponse.response.status, 429);
  assert.ok(Number(limitedResponse.response.headers.get("retry-after")) >= 1);
  await pool.query("UPDATE partner_rate_limits SET window_start = window_start - INTERVAL '2 minutes' WHERE application_id = $1", [limitedApp.id]);
  assert.equal((await call(limitedKeys[0].apiKey)).response.status, 200);
  const beforeFailedOperation = (await pool.query("SELECT request_count FROM partner_rate_limits WHERE application_id = $1", [limitedApp.id])).rows[0].request_count;
  await assert.rejects(store.withAuthorization(limitedKeys[0].apiKey, ["status:read"], async client => {
    await client.query("UPDATE partners SET name = 'Must roll back' WHERE id = $1", [other.id]);
    throw new PartnerError(400, "invalid_payload", "Invalid resource mutation");
  }), { statusCode: 400 });
  assert.equal((await pool.query("SELECT name FROM partners WHERE id = $1", [other.id])).rows[0].name, other.name);
  assert.equal((await pool.query("SELECT request_count FROM partner_rate_limits WHERE application_id = $1", [limitedApp.id])).rows[0].request_count, beforeFailedOperation + 1);

  // A key expiring while waiting for the rate-limit lock must never enter work.
  const waitingKey = await store.issueKey({ applicationId: app.id, label: "Expires during lock wait", expiresAt: expiry() });
  const lock = await pool.connect();
  try {
    await lock.query("BEGIN");
    await lock.query("SELECT application_id FROM partner_rate_limits WHERE application_id = $1 FOR UPDATE", [app.id]);
    await pool.query("UPDATE partner_api_keys SET expires_at = clock_timestamp() + INTERVAL '2 seconds' WHERE id = $1", [waitingKey.credential.id]);
    let enteredWork = false;
    const waitingOperation = store.withAuthorization(waitingKey.apiKey, ["status:read"], async () => { enteredWork = true; });
    const rejection = assert.rejects(waitingOperation, { statusCode: 401 });
    let waiting = false;
    for (let attempt = 0; attempt < 50 && !waiting; attempt += 1) {
      waiting = (await pool.query("SELECT 1 FROM pg_stat_activity WHERE wait_event_type = 'Lock' AND query LIKE 'INSERT INTO partner_rate_limits%'")).rowCount > 0;
      if (!waiting) await new Promise(resolve => setTimeout(resolve, 10));
    }
    assert.equal(waiting, true);
    await new Promise(resolve => setTimeout(resolve, 2100));
    await lock.query("COMMIT");
    await rejection;
    assert.equal(enteredWork, false);
  } finally { await lock.query("ROLLBACK"); lock.release(); }
  const audit = (await pool.query("SELECT action FROM partner_audit_logs WHERE partner_id = $1", [partner.id])).rows;
  assert.equal(audit.filter(row => row.action === "partner.created").length, 1);
  assert.equal(audit.filter(row => row.action === "application.created").length, 1);
});

integrationTest("server dispatch keeps partner authentication independent of real social sessions", async t => {
  assert.equal(new URL(databaseUrl).pathname, "/tribes_partner_test");
  const origin = process.env.TRIBES_TEST_ORIGIN;
  if (!origin) { t.skip("TRIBES_TEST_ORIGIN não configurada."); return; }
  const pool = new pg.Pool({ connectionString: databaseUrl });
  const store = createPartnerStore(pool);
  const marker = `dispatch-${randomUUID()}`;
  const partner = await store.createPartner({ slug: marker, name: "Dispatch integration test" });
  let userId;
  t.after(async () => {
    await pool.query("DELETE FROM partner_audit_logs WHERE partner_id = $1", [partner.id]);
    await pool.query("DELETE FROM partner_api_keys WHERE partner_id = $1", [partner.id]);
    await pool.query("DELETE FROM partner_rate_limits WHERE application_id IN (SELECT id FROM partner_applications WHERE partner_id = $1)", [partner.id]);
    await pool.query("DELETE FROM partner_applications WHERE partner_id = $1", [partner.id]);
    await pool.query("DELETE FROM partners WHERE id = $1", [partner.id]);
    if (userId) await pool.query("DELETE FROM users WHERE id = $1", [userId]);
    await pool.end();
  });
  const app = await store.createApplication({ partnerId: partner.id, slug: "server", name: "Server dispatch", scopes: ["status:read"] });
  const issued = await store.issueKey({ applicationId: app.id, label: "Dispatch credential", expiresAt: expiry() });
  userId = (await pool.query("INSERT INTO users (display_name, email, password_hash) VALUES ('Social user', $1, 'test-only') RETURNING id", [`${marker}@example.test`])).rows[0].id;
  const session = createSessionToken();
  await pool.query("INSERT INTO user_sessions (token_hash, user_id, expires_at) VALUES ($1, $2, CURRENT_TIMESTAMP + INTERVAL '1 day')", [digestSessionToken(session), userId]);
  const cookie = { Cookie: `tribes_session=${session}` };
  const bearer = { Authorization: `Bearer ${issued.apiKey}` };
  assert.equal((await fetch(`${origin}/api/v1/partners/status`, { headers: cookie })).status, 401);
  const status = await fetch(`${origin}/api/v1/partners/status`, { headers: bearer });
  assert.equal(status.status, 200);
  assert.equal((await status.json()).partner.id, partner.id);
  assert.equal((await fetch(`${origin}/api/tribes`, { headers: bearer })).status, 401);
  assert.equal((await fetch(`${origin}/api/tribes`, { headers: cookie })).status, 200);
  assert.equal((await (await fetch(`${origin}/api/auth/me`, { headers: cookie })).json()).user.id, userId);
  assert.equal((await fetch(`${origin}/api/v1/partners/status`, { headers: { ...bearer, Origin: "https://frontend.test" } })).status, 403);
  await store.revokeKey(issued.credential.id);
  assert.equal((await fetch(`${origin}/api/v1/partners/status`, { headers: bearer })).status, 401);
  assert.equal((await fetch(`${origin}/api/tribes`, { headers: cookie })).status, 200);
});

integrationTest("operational CLI provisions and revokes real credentials without exposing database details", async t => {
  const { pool, schema } = await fixture(t);
  await applyFoundation(pool);
  const connection = new URL(databaseUrl);
  connection.searchParams.set("options", `-c search_path=${schema}`);
  const cliPath = fileURLToPath(new URL("../partner-admin.mjs", import.meta.url));
  const execute = promisify(execFile);
  async function cli(...args) {
    const output = await execute(process.execPath, [cliPath, ...args], { env: { ...process.env, DATABASE_URL: connection.toString() } });
    assert.equal(output.stderr, "");
    return JSON.parse(output.stdout);
  }
  const created = await cli("create-partner", "--slug", "cli-partner", "--name", "CLI partner");
  assert.equal((await cli("create-partner", "--slug", "cli-partner", "--name", "CLI partner")).partner.id, created.partner.id);
  const app = await cli("create-application", "--partner", created.partner.id, "--slug", "cli-app", "--name", "CLI application", "--scopes", "status:read");
  const key = await cli("issue-key", "--application", app.application.id, "--label", "CLI credential", "--expires-at", expiry());
  assert.equal(typeof key.apiKey, "string");
  const stored = (await pool.query("SELECT * FROM partner_api_keys WHERE id = $1", [key.credential.id])).rows[0];
  assert.equal(JSON.stringify(stored).includes(key.apiKey), false);
  const rotated = await cli("rotate-key", "--key", key.credential.id, "--expires-at", expiry());
  assert.notEqual(rotated.apiKey, key.apiKey);
  const revoked = await cli("revoke-key", "--key", rotated.credential.id);
  assert.equal(Object.hasOwn(revoked, "apiKey"), false);
  assert.ok(revoked.credential.revokedAt);
  assert.equal((await cli("set-application-status", "--application", app.application.id, "--status", "disabled")).application.status, "disabled");
  await assert.rejects(execute(process.execPath, [cliPath, "issue-key", "--application", app.application.id, "--label", "Inactive", "--expires-at", expiry()], { env: { ...process.env, DATABASE_URL: connection.toString() } }), error => {
    assert.equal(error.code, 1);
    assert.equal(error.stdout, "");
    const data = JSON.parse(error.stderr);
    assert.equal(data.code, "integration_disabled");
    assert.equal(error.stderr.includes(key.apiKey), false);
    assert.equal(error.stderr.includes(connection.toString()), false);
    return true;
  });
});
