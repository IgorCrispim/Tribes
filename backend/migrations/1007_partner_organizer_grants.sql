CREATE TABLE partner_organizer_grant_history (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  partner_id UUID NOT NULL,
  application_id UUID NOT NULL,
  partner_tribe_id UUID NOT NULL,
  social_tribe_id_snapshot UUID NOT NULL,
  beneficiary_user_id UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  granted_by UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  capability TEXT NOT NULL DEFAULT 'organizer.manage'
    CHECK (capability = 'organizer.manage'),
  granted_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  revoked_by UUID REFERENCES users(id) ON DELETE RESTRICT,
  revoked_at TIMESTAMPTZ,
  revocation_source TEXT,
  FOREIGN KEY (partner_id, application_id)
    REFERENCES partner_applications(partner_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (partner_id, application_id, partner_tribe_id)
    REFERENCES partner_tribes(partner_id, application_id, id) ON DELETE RESTRICT,
  CHECK (
    (revoked_at IS NULL AND revoked_by IS NULL AND revocation_source IS NULL)
    OR (revoked_at IS NOT NULL AND revocation_source = 'moderator' AND revoked_by IS NOT NULL)
    OR (revoked_at IS NOT NULL AND revocation_source = 'membership_ended' AND revoked_by IS NULL)
    OR (revoked_at IS NOT NULL AND revocation_source = 'social_tribe_deleted' AND revoked_by IS NULL)
  )
);

CREATE UNIQUE INDEX partner_organizer_grant_active_idx
  ON partner_organizer_grant_history
    (partner_id, application_id, partner_tribe_id, social_tribe_id_snapshot, beneficiary_user_id, capability)
  WHERE revoked_at IS NULL;
CREATE INDEX partner_organizer_grant_social_history_idx
  ON partner_organizer_grant_history
    (social_tribe_id_snapshot, granted_at DESC, id DESC);
CREATE INDEX partner_organizer_grant_resource_history_idx
  ON partner_organizer_grant_history
    (partner_id, application_id, partner_tribe_id, granted_at DESC, id DESC);

CREATE FUNCTION revoke_partner_organizer_grants_on_membership_end() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' OR (OLD.status = 'active' AND NEW.status <> 'active') THEN
    WITH revoked AS (
      UPDATE partner_organizer_grant_history
      SET revoked_at = clock_timestamp(), revocation_source = 'membership_ended'
      WHERE social_tribe_id_snapshot = CASE WHEN TG_OP = 'DELETE' THEN OLD.tribe_id ELSE NEW.tribe_id END
        AND beneficiary_user_id = CASE WHEN TG_OP = 'DELETE' THEN OLD.user_id ELSE NEW.user_id END
        AND revoked_at IS NULL
      RETURNING partner_id, application_id, partner_tribe_id
    )
    INSERT INTO partner_audit_logs (partner_id, application_id, action, resource_id)
    SELECT partner_id, application_id, 'organizer.grant_membership_ended', partner_tribe_id
    FROM revoked;
  END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER tribe_memberships_revoke_partner_organizer_grants
  AFTER UPDATE OF status ON tribe_memberships
  FOR EACH ROW EXECUTE FUNCTION revoke_partner_organizer_grants_on_membership_end();

CREATE TRIGGER tribe_memberships_delete_revoke_partner_organizer_grants
  AFTER DELETE ON tribe_memberships
  FOR EACH ROW EXECUTE FUNCTION revoke_partner_organizer_grants_on_membership_end();

CREATE FUNCTION revoke_partner_organizer_grants_on_tribe_delete() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  WITH revoked AS (
    UPDATE partner_organizer_grant_history
    SET revoked_at = clock_timestamp(), revocation_source = 'social_tribe_deleted'
    WHERE social_tribe_id_snapshot = OLD.id AND revoked_at IS NULL
    RETURNING partner_id, application_id, partner_tribe_id
  )
  INSERT INTO partner_audit_logs (partner_id, application_id, action, resource_id)
  SELECT partner_id, application_id, 'organizer.grant_social_tribe_deleted', partner_tribe_id
  FROM revoked;
  RETURN OLD;
END;
$$;

CREATE TRIGGER tribes_revoke_partner_organizer_grants_after_delete
  BEFORE DELETE ON tribes
  FOR EACH ROW EXECUTE FUNCTION revoke_partner_organizer_grants_on_tribe_delete();

ALTER TABLE partner_applications DROP CONSTRAINT partner_applications_scopes_check;
ALTER TABLE partner_applications ADD CONSTRAINT partner_applications_scopes_check
  CHECK (cardinality(scopes) BETWEEN 1 AND 9 AND scopes <@ ARRAY[
    'status:read', 'events:read', 'events:write', 'organizers:write',
    'moderators:write', 'participants:write', 'invitations:write', 'moderators:read',
    'organizer-grants:read'
  ]::text[]);

ALTER TABLE partner_api_keys DROP CONSTRAINT partner_api_keys_scopes_check;
ALTER TABLE partner_api_keys ADD CONSTRAINT partner_api_keys_scopes_check
  CHECK (cardinality(scopes) BETWEEN 1 AND 9 AND scopes <@ ARRAY[
    'status:read', 'events:read', 'events:write', 'organizers:write',
    'moderators:write', 'participants:write', 'invitations:write', 'moderators:read',
    'organizer-grants:read'
  ]::text[]);
