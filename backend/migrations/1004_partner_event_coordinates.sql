-- PostgreSQL CHECK constraints accept UNKNOWN; require both coordinates to be
-- present so a one-sided latitude/longitude pair cannot pass validation.
ALTER TABLE partner_events
  DROP CONSTRAINT partner_events_check1,
  ADD CONSTRAINT partner_events_location_coordinates_valid
    CHECK (
      (location_lat IS NULL AND location_lon IS NULL)
      OR (
        location_lat IS NOT NULL AND location_lon IS NOT NULL
        AND location_lat BETWEEN -90 AND 90
        AND location_lon BETWEEN -180 AND 180
      )
    );
