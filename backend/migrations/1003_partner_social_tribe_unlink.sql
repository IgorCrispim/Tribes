-- Deleting a social tribe must not fail because a partner keeps a provisional
-- mapping. Preserve that record as unlinked instead of blocking social deletion.
ALTER TABLE partner_tribes
  DROP CONSTRAINT partner_tribes_social_tribe_id_fkey,
  ADD CONSTRAINT partner_tribes_social_tribe_id_fkey
    FOREIGN KEY (social_tribe_id) REFERENCES tribes(id) ON DELETE SET NULL;
