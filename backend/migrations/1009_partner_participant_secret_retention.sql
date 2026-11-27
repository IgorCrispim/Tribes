ALTER TABLE partner_event_participants
  ADD COLUMN claim_token_version BIGINT NOT NULL DEFAULT 1 CHECK (claim_token_version >= 1);

CREATE TABLE partner_event_participant_claim_token_hashes (
  token_hash CHAR(64) PRIMARY KEY CHECK (token_hash ~ '^[a-f0-9]{64}$'),
  participant_id UUID REFERENCES partner_event_participants(id) ON DELETE SET NULL,
  secret_version BIGINT NOT NULL CHECK (secret_version >= 1),
  recorded_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX partner_event_participant_claim_hashes_participant_idx
  ON partner_event_participant_claim_token_hashes (participant_id, secret_version)
  WHERE participant_id IS NOT NULL;

INSERT INTO partner_event_participant_claim_token_hashes (token_hash, participant_id, secret_version)
SELECT claim_token_hash, id, claim_token_version
FROM partner_event_participants
WHERE claim_token_hash IS NOT NULL;

-- A challenge issued before version binding cannot safely be upgraded. Consumed
-- challenges remain for the existing same-user idempotency contract.
DELETE FROM partner_event_participant_previews WHERE consumed_at IS NULL;
ALTER TABLE partner_event_participant_previews
  ADD COLUMN claim_token_version BIGINT,
  ADD COLUMN claim_token_hash CHAR(64);
UPDATE partner_event_participant_previews preview
SET claim_token_version = participant.claim_token_version,
    claim_token_hash = participant.claim_token_hash
FROM partner_event_participants participant
WHERE participant.id = preview.participant_id;
-- 1008 permits clearing an already-consumed participant secret. Consumed
-- challenges need only their confirmation hash for idempotent retries; do not
-- invent a participant secret hash during this upgrade.
ALTER TABLE partner_event_participant_previews
  ALTER COLUMN claim_token_version SET NOT NULL,
  ADD CONSTRAINT partner_participant_preview_secret_version_check CHECK (claim_token_version >= 1),
  ADD CONSTRAINT partner_participant_preview_secret_hash_check
    CHECK (claim_token_hash IS NULL OR claim_token_hash ~ '^[a-f0-9]{64}$'),
  ADD CONSTRAINT partner_participant_preview_secret_hash_required_check
    CHECK (claim_token_hash IS NOT NULL OR consumed_at IS NOT NULL);

ALTER TABLE partner_event_participant_history
  ALTER COLUMN participant_resource_id DROP NOT NULL;

ALTER TABLE partner_audit_logs
  ALTER COLUMN resource_id DROP NOT NULL,
  ADD COLUMN partner_event_id UUID,
  ADD CONSTRAINT partner_audit_logs_event_application_check
    CHECK (partner_event_id IS NULL OR application_id IS NOT NULL),
  ADD CONSTRAINT partner_audit_logs_event_tenant_fkey
    FOREIGN KEY (partner_id, application_id, partner_event_id)
    REFERENCES partner_events(partner_id, application_id, id) ON DELETE RESTRICT;

UPDATE partner_audit_logs audit
SET partner_event_id = participant.partner_event_id
FROM partner_event_participants participant
WHERE audit.resource_id = participant.id
  AND audit.action LIKE 'participant.%'
  AND audit.partner_id = participant.partner_id
  AND audit.application_id = participant.application_id;
UPDATE partner_audit_logs audit
SET partner_event_id = history.partner_event_id
FROM partner_event_participant_history history
WHERE audit.resource_id = history.participant_resource_id
  AND audit.action LIKE 'participant.%'
  AND history.action LIKE 'participant.%'
  AND audit.partner_id = history.partner_id
  AND audit.application_id = history.application_id
  AND audit.partner_event_id IS NULL;

CREATE TABLE partner_event_participant_audit_aggregates (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  partner_id UUID NOT NULL,
  application_id UUID NOT NULL,
  partner_event_id UUID,
  action TEXT NOT NULL CHECK (action LIKE 'participant.%'),
  source TEXT NOT NULL CHECK (source IN ('participant_history', 'partner_audit')),
  occurrence_count BIGINT NOT NULL CHECK (occurrence_count > 0),
  aggregated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY (partner_id, application_id)
    REFERENCES partner_applications(partner_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (partner_id, application_id, partner_event_id)
    REFERENCES partner_events(partner_id, application_id, id) ON DELETE RESTRICT,
  CHECK (partner_event_id IS NOT NULL OR source = 'partner_audit')
);
CREATE UNIQUE INDEX partner_participant_audit_aggregate_event_idx
  ON partner_event_participant_audit_aggregates
    (partner_id, application_id, partner_event_id, action, source)
  WHERE partner_event_id IS NOT NULL;
CREATE UNIQUE INDEX partner_participant_audit_aggregate_unresolved_idx
  ON partner_event_participant_audit_aggregates
    (partner_id, application_id, action, source)
  WHERE partner_event_id IS NULL;

-- Earlier runs deleted participant rows but retained participant_resource_id and
-- per-operation audit timestamps. Convert those legacy rows to non-identifying
-- counts before removing the correlatable source rows.
INSERT INTO partner_event_participant_audit_aggregates
  (partner_id, application_id, partner_event_id, action, source, occurrence_count)
SELECT partner_id, application_id, partner_event_id, action, 'participant_history', count(*)
FROM partner_event_participant_history
WHERE participant_id IS NULL AND action LIKE 'participant.%'
GROUP BY partner_id, application_id, partner_event_id, action
ON CONFLICT (partner_id, application_id, partner_event_id, action, source)
  WHERE partner_event_id IS NOT NULL
  DO UPDATE SET occurrence_count = partner_event_participant_audit_aggregates.occurrence_count + EXCLUDED.occurrence_count;

INSERT INTO partner_event_participant_audit_aggregates
  (partner_id, application_id, partner_event_id, action, source, occurrence_count)
SELECT partner_id, application_id, NULL, action, 'partner_audit', count(*)
FROM partner_audit_logs
WHERE action LIKE 'participant.%' AND partner_event_id IS NULL
  AND NOT EXISTS (
    SELECT 1 FROM partner_event_participants participant
    WHERE participant.id = partner_audit_logs.resource_id
  )
GROUP BY partner_id, application_id, action
ON CONFLICT (partner_id, application_id, action, source)
  WHERE partner_event_id IS NULL
  DO UPDATE SET occurrence_count = partner_event_participant_audit_aggregates.occurrence_count + EXCLUDED.occurrence_count;

INSERT INTO partner_event_participant_audit_aggregates
  (partner_id, application_id, partner_event_id, action, source, occurrence_count)
SELECT partner_id, application_id, partner_event_id, action, 'partner_audit', count(*)
FROM partner_audit_logs
WHERE action LIKE 'participant.%' AND partner_event_id IS NOT NULL
  AND NOT EXISTS (
    SELECT 1 FROM partner_event_participants participant
    WHERE participant.id = partner_audit_logs.resource_id
  )
GROUP BY partner_id, application_id, partner_event_id, action
ON CONFLICT (partner_id, application_id, partner_event_id, action, source)
  WHERE partner_event_id IS NOT NULL
  DO UPDATE SET occurrence_count = partner_event_participant_audit_aggregates.occurrence_count + EXCLUDED.occurrence_count;

DELETE FROM partner_event_participant_history WHERE participant_id IS NULL;
DELETE FROM partner_audit_logs audit
WHERE audit.action LIKE 'participant.%'
  AND NOT EXISTS (
    SELECT 1 FROM partner_event_participants participant
    WHERE participant.id = audit.resource_id
  );

CREATE TABLE partner_participant_retention_runs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  started_at TIMESTAMPTZ NOT NULL,
  completed_at TIMESTAMPTZ NOT NULL,
  duration_ms BIGINT NOT NULL CHECK (duration_ms >= 0),
  previews_deleted INTEGER NOT NULL CHECK (previews_deleted >= 0),
  participants_processed INTEGER NOT NULL CHECK (participants_processed >= 0),
  history_rows_aggregated INTEGER NOT NULL CHECK (history_rows_aggregated >= 0),
  audit_rows_aggregated INTEGER NOT NULL CHECK (audit_rows_aggregated >= 0)
);
CREATE INDEX partner_participant_retention_runs_completed_idx
  ON partner_participant_retention_runs (completed_at DESC);
