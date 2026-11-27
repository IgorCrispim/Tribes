-- Forward-only strengthening: retain the already applied foundation migration.
ALTER TABLE partner_api_keys ADD CONSTRAINT partner_api_keys_tenant_identity_key
  UNIQUE (partner_id, application_id, id);

ALTER TABLE partner_audit_logs ADD CONSTRAINT partner_audit_logs_credential_application_check
  CHECK (credential_id IS NULL OR application_id IS NOT NULL);

ALTER TABLE partner_audit_logs ADD CONSTRAINT partner_audit_logs_credential_tenant_fkey
  FOREIGN KEY (partner_id, application_id, credential_id)
  REFERENCES partner_api_keys(partner_id, application_id, id) ON DELETE RESTRICT;
