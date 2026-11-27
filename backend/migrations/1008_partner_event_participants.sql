ALTER TABLE partner_events
  ADD COLUMN cancelled_at TIMESTAMPTZ;

CREATE TABLE partner_event_participants (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  partner_id UUID NOT NULL,
  application_id UUID NOT NULL,
  partner_event_id UUID NOT NULL,
  external_participant_id TEXT NOT NULL CHECK (
    char_length(external_participant_id) BETWEEN 1 AND 128
    AND external_participant_id = btrim(external_participant_id)
    AND external_participant_id !~ '[[:cntrl:]]'
  ),
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'cancelled')),
  claim_token_hash CHAR(64) CHECK (claim_token_hash IS NULL OR claim_token_hash ~ '^[a-f0-9]{64}$'),
  claim_expires_at TIMESTAMPTZ NOT NULL,
  claim_token_used_at TIMESTAMPTZ,
  claimed_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  claimed_at TIMESTAMPTZ,
  claimed_social_link_id UUID REFERENCES partner_social_tribe_link_history(id) ON DELETE RESTRICT,
  claimed_social_tribe_id_snapshot UUID,
  claimed_social_tribe_name_snapshot TEXT,
  confirmed_preview_id UUID,
  account_unlinked_at TIMESTAMPTZ,
  account_unlinked_by UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY (partner_id, application_id)
    REFERENCES partner_applications(partner_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (partner_id, application_id, partner_event_id)
    REFERENCES partner_events(partner_id, application_id, id) ON DELETE RESTRICT,
  UNIQUE (partner_id, application_id, partner_event_id, external_participant_id),
  CHECK ((claimed_user_id IS NULL AND claimed_at IS NULL AND claimed_social_link_id IS NULL
          AND claimed_social_tribe_id_snapshot IS NULL)
         OR (claimed_at IS NOT NULL AND claimed_social_link_id IS NOT NULL
             AND claimed_social_tribe_id_snapshot IS NOT NULL
             AND claimed_social_tribe_name_snapshot IS NOT NULL)),
  CHECK ((claimed_at IS NULL AND confirmed_preview_id IS NULL) OR
         (claimed_at IS NOT NULL AND confirmed_preview_id IS NOT NULL)),
  CHECK (claim_token_hash IS NOT NULL OR claim_token_used_at IS NOT NULL OR status = 'cancelled'),
  CHECK (status <> 'cancelled' OR claim_token_used_at IS NULL OR claimed_at IS NOT NULL)
);
CREATE INDEX partner_event_participants_user_idx
  ON partner_event_participants (claimed_user_id, claimed_at DESC)
  WHERE claimed_user_id IS NOT NULL AND account_unlinked_at IS NULL;
CREATE INDEX partner_event_participants_event_idx
  ON partner_event_participants (partner_event_id, created_at DESC);
CREATE UNIQUE INDEX partner_event_participants_claim_token_hash_idx
  ON partner_event_participants (claim_token_hash) WHERE claim_token_hash IS NOT NULL;

CREATE TABLE partner_event_participant_previews (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  confirmation_token_hash CHAR(64) NOT NULL UNIQUE
    CHECK (confirmation_token_hash ~ '^[a-f0-9]{64}$'),
  participant_id UUID NOT NULL REFERENCES partner_event_participants(id) ON DELETE CASCADE,
  requested_by UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  partner_social_link_id UUID NOT NULL REFERENCES partner_social_tribe_link_history(id) ON DELETE RESTRICT,
  social_tribe_id_snapshot UUID NOT NULL,
  partner_event_updated_at_snapshot TIMESTAMPTZ NOT NULL,
  partner_event_title_snapshot TEXT NOT NULL,
  social_tribe_name_snapshot TEXT NOT NULL,
  social_tribe_private_snapshot BOOLEAN NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  expires_at TIMESTAMPTZ NOT NULL,
  consumed_at TIMESTAMPTZ,
  confirmed_by UUID REFERENCES users(id) ON DELETE SET NULL,
  CHECK (expires_at > created_at),
  CHECK ((consumed_at IS NULL AND confirmed_by IS NULL) OR
         (consumed_at IS NOT NULL AND confirmed_by IS NOT NULL))
);
CREATE INDEX partner_event_participant_previews_expiry_idx
  ON partner_event_participant_previews (expires_at);

CREATE TABLE partner_event_participant_history (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  partner_id UUID NOT NULL,
  application_id UUID NOT NULL,
  partner_event_id UUID NOT NULL,
  participant_id UUID REFERENCES partner_event_participants(id) ON DELETE SET NULL,
  participant_resource_id UUID NOT NULL,
  action TEXT NOT NULL CHECK (action IN (
    'participant.created', 'participant.claim_token_rotated', 'participant.cancelled',
    'participant.account_linked', 'participant.account_unlinked', 'participant.tribe_joined'
  )),
  actor_type TEXT NOT NULL CHECK (actor_type IN ('partner', 'user', 'system')),
  actor_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  social_tribe_id_snapshot UUID,
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY (partner_id, application_id)
    REFERENCES partner_applications(partner_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (partner_id, application_id, partner_event_id)
    REFERENCES partner_events(partner_id, application_id, id) ON DELETE RESTRICT
);
CREATE INDEX partner_event_participant_history_event_idx
  ON partner_event_participant_history (partner_event_id, created_at DESC);
CREATE INDEX partner_event_participant_history_resource_idx
  ON partner_event_participant_history (participant_resource_id, created_at DESC);
