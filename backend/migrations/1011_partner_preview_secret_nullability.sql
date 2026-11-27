-- Forward-only repair for databases where an earlier 1009 made preview hashes
-- mandatory. Consumed previews may legitimately outlive a cleared participant
-- secret; their confirmation-token hash and consumed state preserve idempotency.
-- Rebuild every check involving claim_token_hash so this also replaces an older
-- equivalent constraint under a different generated name. No row values/hashes
-- are synthesized or changed.
ALTER TABLE partner_event_participant_previews
  ALTER COLUMN claim_token_hash DROP NOT NULL;

DO $$
DECLARE
  existing_constraint RECORD;
BEGIN
  FOR existing_constraint IN
    SELECT conname
    FROM pg_constraint
    WHERE conrelid = 'partner_event_participant_previews'::regclass
      AND contype = 'c'
      AND position('claim_token_hash' IN pg_get_constraintdef(oid)) > 0
  LOOP
    EXECUTE format(
      'ALTER TABLE partner_event_participant_previews DROP CONSTRAINT %I',
      existing_constraint.conname
    );
  END LOOP;
END;
$$;

ALTER TABLE partner_event_participant_previews
  ADD CONSTRAINT partner_participant_preview_secret_hash_check
    CHECK (claim_token_hash IS NULL OR claim_token_hash ~ '^[a-f0-9]{64}$'),
  ADD CONSTRAINT partner_participant_preview_secret_hash_required_check
    CHECK (claim_token_hash IS NOT NULL OR consumed_at IS NOT NULL);

-- Tombstone hashes must never be readable through PUBLIC. The runtime role gets
-- access through the security-definer write function only; ownership/superuser
-- status defeats ACL restrictions and must be checked operationally.
REVOKE ALL ON TABLE partner_event_participant_claim_token_hashes FROM PUBLIC;

DO $$
DECLARE
  target_schema TEXT := current_schema();
BEGIN
  EXECUTE format($create_function$
    CREATE OR REPLACE FUNCTION %I.record_partner_participant_claim_token_hash(
      p_token_hash CHAR(64),
      p_participant_id UUID,
      p_secret_version BIGINT
    ) RETURNS BOOLEAN
    LANGUAGE plpgsql
    SECURITY DEFINER
    SET search_path = pg_catalog
    AS $function_body$
    BEGIN
      INSERT INTO %I.partner_event_participant_claim_token_hashes
        (token_hash, participant_id, secret_version)
      VALUES (p_token_hash, p_participant_id, p_secret_version)
      ON CONFLICT (token_hash) DO NOTHING;
      RETURN FOUND;
    END;
    $function_body$
  $create_function$, target_schema, target_schema);
END;
$$;

REVOKE ALL ON FUNCTION record_partner_participant_claim_token_hash(CHAR, UUID, BIGINT) FROM PUBLIC;
