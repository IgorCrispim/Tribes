-- Preserve audit for automatic revocation caused by social tribe deletion.
CREATE OR REPLACE FUNCTION revoke_partner_social_links_on_tribe_delete() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  WITH revoked AS (
    UPDATE partner_social_tribe_link_history
    SET revoked_at = clock_timestamp(), revocation_source = 'tribe_deleted'
    WHERE social_tribe_id_snapshot = OLD.id AND revoked_at IS NULL
    RETURNING partner_id, application_id, partner_tribe_id
  )
  INSERT INTO partner_audit_logs (partner_id, application_id, action, resource_id)
  SELECT partner_id, application_id, 'tribe.social_link_revoked', partner_tribe_id FROM revoked;
  DELETE FROM partner_social_link_previews WHERE social_tribe_id = OLD.id;
  RETURN OLD;
END;
$$;
