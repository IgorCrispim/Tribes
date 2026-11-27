-- Partner-managed resources stay outside the social feed until an explicit
-- organizer-claim/publication flow is implemented.
CREATE TABLE partner_tribes (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  partner_id UUID NOT NULL,
  application_id UUID NOT NULL,
  external_tribe_id TEXT NOT NULL CHECK (
    char_length(external_tribe_id) BETWEEN 1 AND 128
    AND external_tribe_id = btrim(external_tribe_id)
    AND external_tribe_id !~ '[[:cntrl:]]'
  ),
  social_tribe_id UUID REFERENCES tribes(id) ON DELETE RESTRICT,
  name TEXT NOT NULL CHECK (char_length(name) BETWEEN 2 AND 80),
  description TEXT NOT NULL CHECK (char_length(description) BETWEEN 2 AND 1000),
  category TEXT NOT NULL CHECK (char_length(category) BETWEEN 2 AND 60),
  format TEXT NOT NULL CHECK (format IN ('Presencial', 'Híbrido', 'Online')),
  city TEXT NOT NULL CHECK (char_length(city) BETWEEN 2 AND 100),
  neighborhood TEXT NOT NULL DEFAULT '' CHECK (char_length(neighborhood) <= 100),
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (partner_id, application_id)
    REFERENCES partner_applications(partner_id, id) ON DELETE RESTRICT,
  UNIQUE (partner_id, application_id, id),
  UNIQUE (partner_id, application_id, external_tribe_id),
  UNIQUE (partner_id, application_id, social_tribe_id)
);
CREATE INDEX partner_tribes_social_tribe_idx ON partner_tribes (social_tribe_id)
  WHERE social_tribe_id IS NOT NULL;

CREATE TABLE partner_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  partner_id UUID NOT NULL,
  application_id UUID NOT NULL,
  partner_tribe_id UUID NOT NULL,
  external_event_id TEXT NOT NULL CHECK (
    char_length(external_event_id) BETWEEN 1 AND 128
    AND external_event_id = btrim(external_event_id)
    AND external_event_id !~ '[[:cntrl:]]'
  ),
  title TEXT NOT NULL CHECK (char_length(title) BETWEEN 2 AND 120),
  description TEXT NOT NULL CHECK (char_length(description) BETWEEN 1 AND 5000),
  starts_at TIMESTAMPTZ NOT NULL,
  ends_at TIMESTAMPTZ,
  location TEXT NOT NULL CHECK (char_length(location) BETWEEN 2 AND 240),
  location_lat DOUBLE PRECISION,
  location_lon DOUBLE PRECISION,
  cost TEXT NOT NULL DEFAULT '' CHECK (char_length(cost) <= 100),
  max_attendees INTEGER CHECK (max_attendees IS NULL OR max_attendees BETWEEN 1 AND 10000),
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (partner_id, application_id)
    REFERENCES partner_applications(partner_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (partner_id, application_id, partner_tribe_id)
    REFERENCES partner_tribes(partner_id, application_id, id) ON DELETE RESTRICT,
  UNIQUE (partner_id, application_id, id),
  -- The external event identity is partner-wide by contract. application_id is
  -- retained separately and checked on every access as the operational owner.
  UNIQUE (partner_id, external_event_id),
  CHECK (ends_at IS NULL OR ends_at > starts_at),
  CHECK (
    (location_lat IS NULL AND location_lon IS NULL)
    OR (location_lat BETWEEN -90 AND 90 AND location_lon BETWEEN -180 AND 180)
  )
);
CREATE INDEX partner_events_application_tribe_starts_idx
  ON partner_events (partner_id, application_id, partner_tribe_id, starts_at, id);
