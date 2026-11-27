const rolePolicyError = "Runtime PostgreSQL role must be NOSUPERUSER, NOBYPASSRLS, non-owner, membership-free, and satisfy the tombstone least-privilege policy.";

export function assertTombstoneRuntimeRole(access, configuredRoleName) {
  if (!access) {
    throw new Error("Could not inspect the effective PostgreSQL runtime role and tombstone privileges.");
  }
  if (access.runtime_role !== configuredRoleName) {
    throw new Error("DATABASE_RUNTIME_ROLE does not match the effective PostgreSQL role.");
  }
  if (access.rolsuper || access.rolbypassrls || access.owns_table || access.has_role_memberships ||
      access.can_select || access.can_insert || access.can_update || access.can_delete ||
      access.can_truncate || access.can_reference || access.can_trigger || access.public_table_access ||
      !access.can_execute || access.public_function_access) {
    throw new Error(rolePolicyError);
  }
}
