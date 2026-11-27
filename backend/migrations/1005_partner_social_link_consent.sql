-- Never convert a legacy CLI-created link into a verified consent. Keep the
-- migration atomic and require an explicit review if any such live links exist.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM partner_tribes WHERE social_tribe_id IS NOT NULL) THEN
    RAISE EXCEPTION 'Migration 1005 blocked: legacy social tribe links need moderator consent review';
  END IF;
END;
$$;

CREATE TABLE partner_social_link_previews (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  token_hash CHAR(64) NOT NULL UNIQUE CHECK (token_hash ~ '^[a-f0-9]{64}$'),
  partner_id UUID NOT NULL,
  application_id UUID NOT NULL,
  partner_tribe_id UUID NOT NULL,
  social_tribe_id UUID NOT NULL REFERENCES tribes(id) ON DELETE CASCADE,
  requested_by UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  external_tribe_id TEXT NOT NULL,
  partner_slug_snapshot TEXT NOT NULL,
  partner_name_snapshot TEXT NOT NULL,
  application_slug_snapshot TEXT NOT NULL,
  application_name_snapshot TEXT NOT NULL,
  partner_tribe_updated_at_snapshot TIMESTAMPTZ NOT NULL,
  social_tribe_name_snapshot TEXT NOT NULL,
  social_tribe_moderator_snapshot UUID NOT NULL,
  is_private_snapshot BOOLEAN NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  expires_at TIMESTAMPTZ NOT NULL,
  CHECK (expires_at > created_at),
  FOREIGN KEY (partner_id, application_id)
    REFERENCES partner_applications(partner_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (partner_id, application_id, partner_tribe_id)
    REFERENCES partner_tribes(partner_id, application_id, id) ON DELETE CASCADE
);
CREATE INDEX partner_social_link_previews_expiry_idx
  ON partner_social_link_previews (expires_at);

CREATE TABLE partner_social_tribe_link_history (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  partner_id UUID NOT NULL,
  application_id UUID NOT NULL,
  partner_tribe_id UUID NOT NULL,
  -- Historical snapshot intentionally has no FK: a social tribe can be deleted
  -- without erasing the record of who authorized or revoked its link.
  social_tribe_id_snapshot UUID NOT NULL,
  authorized_by UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  authorized_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  private_at_authorization BOOLEAN NOT NULL,
  private_data_consent BOOLEAN NOT NULL,
  revoked_by UUID REFERENCES users(id) ON DELETE RESTRICT,
  revoked_at TIMESTAMPTZ,
  revocation_source TEXT,
  FOREIGN KEY (partner_id, application_id)
    REFERENCES partner_applications(partner_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (partner_id, application_id, partner_tribe_id)
    REFERENCES partner_tribes(partner_id, application_id, id) ON DELETE RESTRICT,
  CHECK (NOT private_at_authorization OR private_data_consent),
  CHECK (
    (revoked_at IS NULL AND revoked_by IS NULL AND revocation_source IS NULL)
    OR (revoked_at IS NOT NULL AND revocation_source = 'moderator' AND revoked_by IS NOT NULL)
    OR (revoked_at IS NOT NULL AND revocation_source = 'tribe_deleted' AND revoked_by IS NULL)
  )
);
CREATE UNIQUE INDEX partner_social_tribe_link_active_idx
  ON partner_social_tribe_link_history (partner_id, application_id, partner_tribe_id)
  WHERE revoked_at IS NULL;
CREATE INDEX partner_social_tribe_link_history_social_idx
  ON partner_social_tribe_link_history (social_tribe_id_snapshot, authorized_at DESC);

CREATE FUNCTION revoke_partner_social_links_on_tribe_delete() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  UPDATE partner_social_tribe_link_history
  SET revoked_at = clock_timestamp(), revocation_source = 'tribe_deleted'
  WHERE social_tribe_id_snapshot = OLD.id AND revoked_at IS NULL;
  DELETE FROM partner_social_link_previews WHERE social_tribe_id = OLD.id;
  RETURN OLD;
END;
$$;

CREATE TRIGGER tribes_revoke_partner_links_after_delete
  AFTER DELETE ON tribes
  FOR EACH ROW EXECUTE FUNCTION revoke_partner_social_links_on_tribe_delete();
