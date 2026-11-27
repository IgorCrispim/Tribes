import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { assertTombstoneRuntimeRole } from "../runtime-role-policy.mjs";

const safeRuntimeRole = {
  runtime_role: "tribes_app",
  rolsuper: false,
  rolbypassrls: false,
  owns_table: false,
  has_role_memberships: false,
  can_select: false,
  can_insert: false,
  can_update: false,
  can_delete: false,
  can_truncate: false,
  can_reference: false,
  can_trigger: false,
  public_table_access: false,
  can_execute: true,
  public_function_access: false,
};

test("runtime role policy accepts an effective NOBYPASSRLS role with least-privilege tombstone access", () => {
  assert.doesNotThrow(() => assertTombstoneRuntimeRole(safeRuntimeRole, "tribes_app"));
});

test("runtime role policy rejects BYPASSRLS without exposing connection details", () => {
  const sensitiveConnection = "postgres://runtime:should-never-appear@database/private";
  assert.throws(
    () => assertTombstoneRuntimeRole({ ...safeRuntimeRole, rolbypassrls: true }, "tribes_app"),
    error => error.message.includes("NOBYPASSRLS") && !error.message.includes(sensitiveConnection),
  );
});

test("runtime role policy continues rejecting superuser, ownership, memberships, and tombstone ACL violations", () => {
  for (const field of [
    "rolsuper", "owns_table", "has_role_memberships", "can_select", "can_insert", "can_update",
    "can_delete", "can_truncate", "can_reference", "can_trigger", "public_table_access",
    "public_function_access",
  ]) {
    assert.throws(
      () => assertTombstoneRuntimeRole({ ...safeRuntimeRole, [field]: true }, "tribes_app"),
      /least-privilege policy/,
      `${field} must remain prohibited`,
    );
  }
  assert.throws(
    () => assertTombstoneRuntimeRole({ ...safeRuntimeRole, can_execute: false }, "tribes_app"),
    /least-privilege policy/,
  );
});

test("runtime role bootstrap explicitly creates and alters tribes_app with NOBYPASSRLS", async () => {
  const script = await readFile(new URL("../postgres-init-runtime-role.sh", import.meta.url), "utf8");
  assert.match(script, /CREATE ROLE tribes_app[\s\S]*?NOSUPERUSER NOBYPASSRLS/);
  assert.match(script, /ALTER ROLE tribes_app[\s\S]*?NOSUPERUSER NOBYPASSRLS/);
  assert.match(script, /WHERE NOT EXISTS \(SELECT 1 FROM pg_roles WHERE rolname = 'tribes_app'\)/);
  assert.doesNotMatch(script, /ALTER ROLE tribes_migrator/);
});
