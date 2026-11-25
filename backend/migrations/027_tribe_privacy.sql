ALTER TABLE tribes
  ADD COLUMN is_private BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN password_hash TEXT,
  ADD CONSTRAINT tribes_privacy_password_check CHECK (
    (is_private AND password_hash IS NOT NULL) OR
    (NOT is_private AND password_hash IS NULL)
  );
