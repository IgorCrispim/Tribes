CREATE TABLE tribe_invitations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tribe_id UUID NOT NULL REFERENCES tribes(id) ON DELETE CASCADE,
  inviter_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  email TEXT NOT NULL,
  token_hash CHAR(64) NOT NULL UNIQUE,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'accepted', 'declined', 'cancelled', 'expired')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  expires_at TIMESTAMPTZ NOT NULL DEFAULT (CURRENT_TIMESTAMP + INTERVAL '7 days'),
  responded_at TIMESTAMPTZ
);
CREATE UNIQUE INDEX tribe_invitations_pending_idx ON tribe_invitations (tribe_id, email) WHERE status = 'pending';
CREATE INDEX tribe_invitations_inviter_created_idx ON tribe_invitations (inviter_id, created_at DESC);
CREATE INDEX tribe_invitations_email_idx ON tribe_invitations (email, created_at DESC) WHERE status = 'pending';

ALTER TABLE notifications DROP CONSTRAINT IF EXISTS notifications_type_check;
ALTER TABLE notifications ADD CONSTRAINT notifications_type_check
  CHECK (type IN ('post_like', 'post_comment', 'event_created', 'event_attendance', 'tribe_invitation'));
ALTER TABLE notifications ADD COLUMN invitation_id UUID REFERENCES tribe_invitations(id) ON DELETE CASCADE;
CREATE UNIQUE INDEX notifications_invitation_idx ON notifications (invitation_id) WHERE invitation_id IS NOT NULL;

ALTER TABLE email_queue DROP CONSTRAINT IF EXISTS email_queue_kind_check;
ALTER TABLE email_queue ADD CONSTRAINT email_queue_kind_check CHECK (kind IN ('registration', 'password_reset', 'tribe_invitation'));
ALTER TABLE email_queue ADD COLUMN invitation_id UUID REFERENCES tribe_invitations(id) ON DELETE SET NULL;
ALTER TABLE registration_tokens ADD COLUMN invitation_id UUID REFERENCES tribe_invitations(id) ON DELETE SET NULL;
