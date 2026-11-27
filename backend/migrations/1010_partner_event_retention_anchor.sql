ALTER TABLE partner_events
  ADD COLUMN participant_retention_at TIMESTAMPTZ;

-- Preserve the best available terminal time for existing participants. A
-- cancellation before the scheduled end starts retention at cancellation;
-- otherwise an already-ended event uses its scheduled end (or start).
UPDATE partner_events event
SET participant_retention_at = CASE
  WHEN event.cancelled_at IS NOT NULL
    THEN LEAST(COALESCE(event.ends_at, event.starts_at), event.cancelled_at)
  ELSE COALESCE(event.ends_at, event.starts_at)
END
WHERE EXISTS (
    SELECT 1 FROM partner_event_participants participant
    WHERE participant.partner_event_id = event.id
  )
  AND (event.cancelled_at IS NOT NULL
       OR COALESCE(event.ends_at, event.starts_at) <= clock_timestamp());

CREATE INDEX partner_events_participant_retention_idx
  ON partner_events (participant_retention_at, id)
  WHERE participant_retention_at IS NOT NULL;

CREATE FUNCTION enforce_partner_event_retention_anchor() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  has_participants BOOLEAN;
  original_terminal_time TIMESTAMPTZ;
  changed_schedule BOOLEAN;
BEGIN
  changed_schedule := ROW(NEW.starts_at, NEW.ends_at)
    IS DISTINCT FROM ROW(OLD.starts_at, OLD.ends_at);

  IF OLD.cancelled_at IS NOT NULL AND (
       NEW.cancelled_at IS DISTINCT FROM OLD.cancelled_at OR changed_schedule
     ) THEN
    RAISE EXCEPTION 'A cancelled partner event is terminal'
      USING ERRCODE = '23514', CONSTRAINT = 'partner_event_retention_schedule_immutable';
  END IF;

  SELECT EXISTS (
    SELECT 1 FROM partner_event_participants participant
    WHERE participant.partner_event_id = OLD.id
  ) INTO has_participants;

  original_terminal_time := COALESCE(OLD.ends_at, OLD.starts_at);
  IF changed_schedule AND (
       OLD.participant_retention_at IS NOT NULL
       OR (has_participants AND original_terminal_time <= clock_timestamp())
     ) THEN
    RAISE EXCEPTION 'Dates cannot change after a participant event reaches its end'
      USING ERRCODE = '23514', CONSTRAINT = 'partner_event_retention_schedule_immutable';
  END IF;

  IF OLD.participant_retention_at IS NOT NULL THEN
    NEW.participant_retention_at := OLD.participant_retention_at;
  ELSIF has_participants THEN
    IF NEW.cancelled_at IS NOT NULL THEN
      NEW.participant_retention_at := LEAST(original_terminal_time, NEW.cancelled_at);
    ELSIF original_terminal_time <= clock_timestamp() THEN
      NEW.participant_retention_at := original_terminal_time;
    ELSIF changed_schedule
        AND COALESCE(NEW.ends_at, NEW.starts_at) <= clock_timestamp() THEN
      -- A reschedule that moves a participant-bearing event into the past is
      -- terminal at the time that transition is observed, never retroactively.
      NEW.participant_retention_at := clock_timestamp();
    ELSE
      NEW.participant_retention_at := NULL;
    END IF;
  ELSE
    -- Events without participants retain their existing rescheduling behavior.
    NEW.participant_retention_at := OLD.participant_retention_at;
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER partner_events_retention_anchor_guard
  BEFORE UPDATE OF starts_at, ends_at, cancelled_at, participant_retention_at
  ON partner_events
  FOR EACH ROW EXECUTE FUNCTION enforce_partner_event_retention_anchor();
