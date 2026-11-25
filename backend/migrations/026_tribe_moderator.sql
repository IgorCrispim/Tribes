ALTER TABLE tribes
  ADD COLUMN moderator_id UUID REFERENCES users(id);

UPDATE tribes
SET moderator_id = created_by;

ALTER TABLE tribes
  ALTER COLUMN moderator_id SET NOT NULL;

CREATE INDEX IF NOT EXISTS tribes_moderator_id_idx ON tribes (moderator_id);
