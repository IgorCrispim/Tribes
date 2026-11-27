-- Independent of social migrations, including 999_profile_customization.sql.
CREATE TABLE partners (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  slug TEXT NOT NULL UNIQUE CHECK (slug ~ '^[a-z0-9][a-z0-9_-]{1,79}$'),
  name TEXT NOT NULL CHECK (char_length(name) BETWEEN 2 AND 120),
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'disabled')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE partner_applications (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  partner_id UUID NOT NULL REFERENCES partners(id) ON DELETE RESTRICT,
  slug TEXT NOT NULL CHECK (slug ~ '^[a-z0-9][a-z0-9_-]{1,79}$'),
  name TEXT NOT NULL CHECK (char_length(name) BETWEEN 2 AND 120),
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'disabled')),
  scopes TEXT[] NOT NULL CHECK (cardinality(scopes) BETWEEN 1 AND 8 AND scopes <@ ARRAY[
    'status:read', 'events:read', 'events:write', 'organizers:write',
    'moderators:write', 'participants:write', 'invitations:write', 'moderators:read'
  ]::text[]),
  requests_per_minute INTEGER NOT NULL DEFAULT 120 CHECK (requests_per_minute BETWEEN 1 AND 10000),
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (partner_id, slug),
  UNIQUE (partner_id, id)
);

CREATE TABLE partner_api_keys (
  id UUID PRIMARY KEY,
  partner_id UUID NOT NULL,
  application_id UUID NOT NULL,
  token_hash CHAR(64) NOT NULL UNIQUE CHECK (token_hash ~ '^[a-f0-9]{64}$'),
  label TEXT NOT NULL CHECK (char_length(label) BETWEEN 2 AND 120),
  scopes TEXT[] NOT NULL CHECK (cardinality(scopes) BETWEEN 1 AND 8 AND scopes <@ ARRAY[
    'status:read', 'events:read', 'events:write', 'organizers:write',
    'moderators:write', 'participants:write', 'invitations:write', 'moderators:read'
  ]::text[]),
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  expires_at TIMESTAMPTZ NOT NULL CHECK (expires_at > created_at),
  revoked_at TIMESTAMPTZ,
  FOREIGN KEY (partner_id, application_id) REFERENCES partner_applications(partner_id, id) ON DELETE RESTRICT
);
CREATE INDEX partner_api_keys_application_idx ON partner_api_keys (application_id, created_at DESC);

-- One row per application: all keys and backend replicas share the same budget.
CREATE TABLE partner_rate_limits (
  application_id UUID PRIMARY KEY REFERENCES partner_applications(id) ON DELETE CASCADE,
  window_start TIMESTAMPTZ NOT NULL,
  request_count INTEGER NOT NULL CHECK (request_count >= 1)
);

-- Operational actions now; domain mutations will also use this in later stages.
-- Deliberately no arbitrary payload, email, token or request body columns.
CREATE TABLE partner_audit_logs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  partner_id UUID NOT NULL REFERENCES partners(id) ON DELETE RESTRICT,
  application_id UUID,
  credential_id UUID,
  action TEXT NOT NULL,
  resource_id UUID NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (partner_id, application_id) REFERENCES partner_applications(partner_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (credential_id) REFERENCES partner_api_keys(id) ON DELETE RESTRICT
);
CREATE INDEX partner_audit_logs_partner_created_idx ON partner_audit_logs (partner_id, created_at DESC, id DESC);
