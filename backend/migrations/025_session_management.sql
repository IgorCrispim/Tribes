ALTER TABLE user_sessions
  ADD COLUMN IF NOT EXISTS id UUID NOT NULL DEFAULT gen_random_uuid(),
  ADD COLUMN IF NOT EXISTS last_seen_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP;

CREATE UNIQUE INDEX IF NOT EXISTS user_sessions_id_idx ON user_sessions (id);
CREATE INDEX IF NOT EXISTS user_sessions_user_activity_idx ON user_sessions (user_id, last_seen_at DESC);
