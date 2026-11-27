import "./load-env.mjs";
import pg from "pg";
import { createHash, randomBytes } from "node:crypto";
import {
  PartnerError, createPartnerKey, matchesPartnerKey, parsePartnerKey,
  partnerExpiry, partnerInvalid, partnerName, partnerScopes, partnerSlug, partnerUuid,
} from "./partner-security.mjs";
import { parseExternalResourceId, parsePartnerClaimToken } from "./partner-resources.mjs";
import { digestSessionToken, verifyPassword } from "./security.mjs";
import { SESSION_MAX_AGE_SECONDS } from "./session-policy.mjs";

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const notFound = () => new PartnerError(404, "resource_not_found", "Recurso não encontrado.");
const unauthenticated = () => new PartnerError(401, "invalid_credentials", "Credencial de integração inválida ou inativa.", { "WWW-Authenticate": "Bearer" });
const participantNotFound = () => new PartnerError(404, "participant_not_found", "Registro não encontrado.");
const participantClaimInvalid = () => new PartnerError(404, "participant_claim_invalid", "O resgate é inválido, expirou ou não está disponível.");
const claimTokenHash = token => createHash("sha256").update(token).digest("hex");
const confirmationToken = () => randomBytes(32).toString("base64url");

function partnerDto(row) {
  return { id: row.id, slug: row.slug, name: row.name, status: row.status, createdAt: row.created_at, updatedAt: row.updated_at };
}
function applicationDto(row) {
  return { ...partnerDto(row), partnerId: row.partner_id, scopes: row.scopes, requestsPerMinute: row.requests_per_minute };
}
function keyDto(row) {
  return { id: row.id, partnerId: row.partner_id, applicationId: row.application_id, label: row.label,
    scopes: row.scopes, createdAt: row.created_at, expiresAt: row.expires_at, revokedAt: row.revoked_at };
}
function partnerTribeDto(row) {
  const linked = Boolean(row.active_social_link_id);
  return { id: row.id, externalTribeId: row.external_tribe_id, name: linked ? row.social_name : row.name,
    description: linked ? row.social_description : row.description, category: linked ? row.social_category : row.category,
    format: linked ? row.social_format : row.format, city: linked ? row.social_city : row.city,
    neighborhood: linked ? row.social_neighborhood : row.neighborhood, linkedToSocialTribe: linked,
    createdAt: row.created_at, updatedAt: row.updated_at };
}
function partnerEventDto(row) {
  const linked = Boolean(row.active_social_link_id);
  return { id: row.id, externalEventId: row.external_event_id,
    tribe: { externalTribeId: row.external_tribe_id, name: linked ? row.social_tribe_name : row.tribe_name,
      linkedToSocialTribe: linked },
    title: row.title, description: row.description, startsAt: row.starts_at, endsAt: row.ends_at,
    location: row.location, lat: row.location_lat, lon: row.location_lon, cost: row.cost,
     maxAttendees: row.max_attendees, status: row.cancelled_at ? "cancelled" : "active",
     cancelledAt: row.cancelled_at, createdAt: row.created_at, updatedAt: row.updated_at };
}
function partnerEventParticipantDto(row) {
  return {
    id: row.id,
    externalParticipantId: row.external_participant_id,
    event: { externalEventId: row.external_event_id, title: row.event_title },
    status: row.status,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}
function organizerGrantDto(row) {
  return {
    id: row.id,
    partnerId: row.partner_id,
    applicationId: row.application_id,
    partnerTribeId: row.partner_tribe_id,
    externalTribeId: row.external_tribe_id,
    socialTribeId: row.social_tribe_id_snapshot,
    beneficiaryUserId: row.beneficiary_user_id,
    capability: row.capability,
    grantedBy: row.granted_by,
    grantedAt: row.granted_at,
    revokedBy: row.revoked_by,
    revokedAt: row.revoked_at,
    revocationSource: row.revocation_source,
    active: row.revoked_at === null,
  };
}

export function createPartnerStore(database = pool) {
  async function transaction(work) {
    const client = await database.connect();
    try {
      await client.query("BEGIN");
      const result = await work(client);
      await client.query("COMMIT");
      return result;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally { client.release(); }
  }

  async function audit(client, { partnerId, applicationId = null, credentialId = null, action, resourceId, partnerEventId = null }) {
    if (partnerEventId === null) {
      await client.query(
        `INSERT INTO partner_audit_logs (partner_id, application_id, credential_id, action, resource_id)
         VALUES ($1, $2, $3, $4, $5)`, [partnerId, applicationId, credentialId, action, resourceId]);
    } else {
      await client.query(
        `INSERT INTO partner_audit_logs
           (partner_id, application_id, credential_id, action, resource_id, partner_event_id)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [partnerId, applicationId, credentialId, action, resourceId, partnerEventId]);
    }
  }

  async function participantHistory(client, { participant, action, actorType, actorUserId = null, socialTribeId = null }) {
    await client.query(
      `INSERT INTO partner_event_participant_history
          (partner_id, application_id, partner_event_id, participant_id, participant_resource_id,
           action, actor_type, actor_user_id, social_tribe_id_snapshot)
       VALUES ($1, $2, $3, $4, $4, $5, $6, $7, $8)`,
      [participant.partner_id, participant.application_id, participant.partner_event_id,
        participant.id, action, actorType, actorUserId, socialTribeId]);
  }

  async function lockSocialSession(client, sessionToken, userId) {
    if (typeof sessionToken !== "string" || sessionToken.length < 32) {
      throw new PartnerError(401, "social_session_required", "Autenticação social necessária.");
    }
    const session = await client.query(
      `SELECT 1 FROM user_sessions
       WHERE token_hash = $1 AND user_id = $2 AND expires_at > clock_timestamp()
         AND created_at + ($3 * INTERVAL '1 second') > clock_timestamp()
       FOR SHARE`,
      [digestSessionToken(sessionToken), userId, SESSION_MAX_AGE_SECONDS]);
    if (!session.rowCount) throw new PartnerError(401, "social_session_required", "Sessão social inválida ou expirada.");
  }

  async function lockSocialModerator(client, { sessionToken, userId, socialTribeId }) {
    await lockSocialSession(client, sessionToken, userId);
    const tribe = (await client.query(
      `SELECT id, name, is_private, moderator_id
       FROM tribes WHERE id = $1 FOR UPDATE`, [socialTribeId])).rows[0];
    if (!tribe) throw new PartnerError(404, "tribe_not_found", "Tribo não encontrada ou sem permissão.");
    const membership = await client.query(
      `SELECT 1 FROM tribe_memberships
       WHERE tribe_id = $1 AND user_id = $2 AND status = 'active' FOR SHARE`,
      [socialTribeId, userId]);
    if (tribe.moderator_id !== userId || !membership.rowCount) {
      throw new PartnerError(404, "tribe_not_found", "Tribo não encontrada ou sem permissão.");
    }
    return tribe;
  }

  async function lockPartnerApplication(client, applicationId, { requireActive = true, requireOrganizerScope = true } = {}) {
    const row = (await client.query(
      `SELECT a.id AS application_id, a.partner_id, a.slug AS application_slug,
              a.name AS application_name, a.status AS application_status, a.scopes AS application_scopes,
              p.slug AS partner_slug, p.name AS partner_name, p.status AS partner_status
       FROM partner_applications a JOIN partners p ON p.id = a.partner_id
       WHERE a.id = $1 FOR SHARE OF a, p`, [applicationId])).rows[0];
    if (!row || (requireActive && (row.partner_status !== "active" || row.application_status !== "active"))) {
      throw new PartnerError(404, "partner_application_not_found", "Aplicação não encontrada ou inativa.");
    }
    if (requireOrganizerScope && !row.application_scopes.includes("organizers:write")) {
      throw new PartnerError(409, "partner_application_scope_missing", "A aplicação não possui o escopo organizers:write.");
    }
    return row;
  }

  async function lockPartnerTribe(client, { partnerId, applicationId, externalTribeId }, mode = "UPDATE") {
    const rows = await client.query(
      `SELECT * FROM partner_tribes
       WHERE partner_id = $1 AND application_id = $2 AND external_tribe_id = $3
       FOR ${mode}`,
      [partnerId, applicationId, externalTribeId]);
    return rows.rows[0] ?? null;
  }

  async function linkHistoryDto(row) {
    return { id: row.id, partnerId: row.partner_id, applicationId: row.application_id,
      partnerTribeId: row.partner_tribe_id, externalTribeId: row.external_tribe_id,
      socialTribeId: row.social_tribe_id_snapshot, partnerSlug: row.partner_slug,
      partnerName: row.partner_name, applicationSlug: row.application_slug,
      applicationName: row.application_name, authorizedBy: row.authorized_by,
      authorizedByName: row.authorized_by_name, authorizedAt: row.authorized_at,
      privateAtAuthorization: row.private_at_authorization,
      privateDataConsent: row.private_data_consent, revokedBy: row.revoked_by,
      revokedByName: row.revoked_by_name, revokedAt: row.revoked_at,
      revocationSource: row.revocation_source, active: row.revoked_at === null };
  }

  async function selectPartnerEventRow(client, principal, externalEventId, forUpdate = false) {
    return (await client.query(
       `SELECT e.*, t.external_tribe_id, t.name AS tribe_name,
               link.id AS active_social_link_id, s.name AS social_tribe_name
       FROM partner_events e JOIN partner_tribes t
         ON t.id = e.partner_tribe_id AND t.partner_id = e.partner_id AND t.application_id = e.application_id
       LEFT JOIN partner_social_tribe_link_history link
         ON link.partner_id = t.partner_id AND link.application_id = t.application_id
        AND link.partner_tribe_id = t.id AND link.social_tribe_id_snapshot = t.social_tribe_id
        AND link.revoked_at IS NULL
       LEFT JOIN tribes s ON s.id = link.social_tribe_id_snapshot
       WHERE e.partner_id = $1 AND e.external_event_id = $2
       ${forUpdate ? "FOR UPDATE OF e FOR SHARE OF t" : "FOR SHARE OF t"}`,
      [principal.partnerId, externalEventId])).rows[0] ?? null;
  }

  async function selectPartnerTribeRow(client, principal, externalTribeId, forUpdate = false) {
    return (await client.query(
      `SELECT p.*, link.id AS active_social_link_id,
              s.name AS social_name, s.description AS social_description, s.category AS social_category,
              s.format AS social_format, s.city AS social_city, s.neighborhood AS social_neighborhood
       FROM partner_tribes p
       LEFT JOIN partner_social_tribe_link_history link
         ON link.partner_id = p.partner_id AND link.application_id = p.application_id
        AND link.partner_tribe_id = p.id AND link.social_tribe_id_snapshot = p.social_tribe_id
        AND link.revoked_at IS NULL
       LEFT JOIN tribes s ON s.id = link.social_tribe_id_snapshot
       WHERE p.partner_id = $1 AND p.application_id = $2 AND p.external_tribe_id = $3
       ${forUpdate ? "FOR UPDATE OF p" : "FOR SHARE OF p"}`,
      [principal.partnerId, principal.applicationId, externalTribeId])).rows[0] ?? null;
  }

  async function lockApplication(client, id) {
    const lookup = await client.query("SELECT partner_id FROM partner_applications WHERE id = $1", [id]);
    if (!lookup.rowCount) throw notFound();
    const partner = await client.query("SELECT * FROM partners WHERE id = $1 FOR SHARE", [lookup.rows[0].partner_id]);
    const app = await client.query("SELECT * FROM partner_applications WHERE id = $1 FOR UPDATE", [id]);
    if (!app.rowCount) throw notFound();
    return { partner: partner.rows[0], app: app.rows[0] };
  }

  async function insertKey(client, app, { label, scopes, expiresAt }) {
    if (scopes.some(scope => !app.scopes.includes(scope))) throw partnerInvalid("Escopos da credencial excedem os da aplicação.");
    const key = createPartnerKey();
    const { rows } = await client.query(
      `INSERT INTO partner_api_keys (id, partner_id, application_id, token_hash, label, scopes, expires_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *`,
      [key.id, app.partner_id, app.id, key.tokenHash, label, scopes, expiresAt]);
    await audit(client, { partnerId: app.partner_id, applicationId: app.id, credentialId: key.id, action: "credential.issued", resourceId: key.id });
    return { credential: keyDto(rows[0]), apiKey: key.token };
  }

  return {
    async createPartner({ slug, name }) {
      slug = partnerSlug(slug); name = partnerName(name);
      return transaction(async client => {
        const inserted = await client.query("INSERT INTO partners (slug, name) VALUES ($1, $2) ON CONFLICT (slug) DO NOTHING RETURNING *", [slug, name]);
        const row = inserted.rows[0] ?? (await client.query("SELECT * FROM partners WHERE slug = $1 FOR SHARE", [slug])).rows[0];
        if (row.name !== name) throw new PartnerError(409, "identity_conflict", "O slug já está associado a outros dados.");
        if (inserted.rowCount) await audit(client, { partnerId: row.id, action: "partner.created", resourceId: row.id });
        return partnerDto(row);
      });
    },

    async createApplication({ partnerId, slug, name, scopes, requestsPerMinute = 120 }) {
      partnerId = partnerUuid(partnerId); slug = partnerSlug(slug); name = partnerName(name); scopes = partnerScopes(scopes);
      if (!Number.isInteger(requestsPerMinute) || requestsPerMinute < 1 || requestsPerMinute > 10000) throw partnerInvalid("Limite por minuto inválido (1–10000).");
      return transaction(async client => {
        const partner = await client.query("SELECT status FROM partners WHERE id = $1 FOR SHARE", [partnerId]);
        if (!partner.rowCount) throw notFound();
        if (partner.rows[0].status !== "active") throw new PartnerError(409, "partner_disabled", "Empresa desativada.");
        const inserted = await client.query(
          `INSERT INTO partner_applications (partner_id, slug, name, scopes, requests_per_minute)
           VALUES ($1, $2, $3, $4, $5) ON CONFLICT (partner_id, slug) DO NOTHING RETURNING *`, [partnerId, slug, name, scopes, requestsPerMinute]);
        const row = inserted.rows[0] ?? (await client.query("SELECT * FROM partner_applications WHERE partner_id = $1 AND slug = $2 FOR SHARE", [partnerId, slug])).rows[0];
        if (row.name !== name || JSON.stringify([...row.scopes].sort()) !== JSON.stringify(scopes) || row.requests_per_minute !== requestsPerMinute) {
          throw new PartnerError(409, "identity_conflict", "O slug da aplicação já está associado a outros dados.");
        }
        if (inserted.rowCount) await audit(client, { partnerId, applicationId: row.id, action: "application.created", resourceId: row.id });
        return applicationDto(row);
      });
    },

    async issueKey({ applicationId, label, scopes, expiresAt }) {
      applicationId = partnerUuid(applicationId); label = partnerName(label); expiresAt = partnerExpiry(expiresAt);
      if (scopes !== undefined) scopes = partnerScopes(scopes);
      return transaction(async client => {
        const { partner, app } = await lockApplication(client, applicationId);
        if (partner.status !== "active" || app.status !== "active") throw new PartnerError(409, "integration_disabled", "Integração desativada.");
        return insertKey(client, app, { label, scopes: scopes ?? app.scopes, expiresAt });
      });
    },

    async revokeKey(id) {
      id = partnerUuid(id);
      return transaction(async client => {
        const lookup = await client.query("SELECT application_id FROM partner_api_keys WHERE id = $1", [id]);
        if (!lookup.rowCount) throw notFound();
        const { app } = await lockApplication(client, lookup.rows[0].application_id);
        const updated = await client.query("UPDATE partner_api_keys SET revoked_at = clock_timestamp() WHERE id = $1 AND revoked_at IS NULL RETURNING *", [id]);
        if (updated.rowCount) await audit(client, { partnerId: app.partner_id, applicationId: app.id, credentialId: id, action: "credential.revoked", resourceId: id });
        const row = updated.rows[0] ?? (await client.query("SELECT * FROM partner_api_keys WHERE id = $1", [id])).rows[0];
        return keyDto(row);
      });
    },

    async rotateKey(id, expiresAt) {
      id = partnerUuid(id); expiresAt = partnerExpiry(expiresAt);
      return transaction(async client => {
        const lookup = await client.query("SELECT application_id FROM partner_api_keys WHERE id = $1", [id]);
        if (!lookup.rowCount) throw notFound();
        const { partner, app } = await lockApplication(client, lookup.rows[0].application_id);
        const old = (await client.query("SELECT * FROM partner_api_keys WHERE id = $1 FOR UPDATE", [id])).rows[0];
        if (partner.status !== "active" || app.status !== "active" || old.revoked_at) throw new PartnerError(409, "rotation_conflict", "Credencial ou integração inativa.");
        const result = await insertKey(client, app, { label: old.label, scopes: old.scopes, expiresAt });
        await client.query("UPDATE partner_api_keys SET revoked_at = clock_timestamp() WHERE id = $1", [id]);
        await audit(client, { partnerId: app.partner_id, applicationId: app.id, credentialId: id, action: "credential.revoked", resourceId: id });
        return result;
      });
    },

    async setStatus(kind, id, status) {
      id = partnerUuid(id);
      if (!["partner", "application"].includes(kind) || !["active", "disabled"].includes(status)) throw partnerInvalid("Estado ou recurso inválido.");
      return transaction(async client => {
        let row;
        if (kind === "partner") {
          row = (await client.query("SELECT * FROM partners WHERE id = $1 FOR UPDATE", [id])).rows[0];
        } else {
          row = (await lockApplication(client, id)).app;
        }
        if (!row) throw notFound();
        if (row.status !== status) {
          const table = kind === "partner" ? "partners" : "partner_applications";
          row = (await client.query(`UPDATE ${table} SET status = $2, updated_at = clock_timestamp() WHERE id = $1 RETURNING *`, [id, status])).rows[0];
          await audit(client, { partnerId: kind === "partner" ? id : row.partner_id, applicationId: kind === "application" ? id : null, action: `${kind}.${status}`, resourceId: id });
        }
        return kind === "partner" ? partnerDto(row) : applicationDto(row);
      });
    },

    async listSocialTribePartnerLinks({ sessionToken, userId, socialTribeId }) {
      userId = partnerUuid(userId); socialTribeId = partnerUuid(socialTribeId);
      return transaction(async client => {
        await lockSocialModerator(client, { sessionToken, userId, socialTribeId });
        const rows = await client.query(
          `SELECT h.*, a.slug AS application_slug, a.name AS application_name,
                  p.slug AS partner_slug, p.name AS partner_name,
                  pt.external_tribe_id, grantor.display_name AS authorized_by_name,
                  revoker.display_name AS revoked_by_name
           FROM partner_social_tribe_link_history h
           JOIN partner_applications a ON a.id = h.application_id AND a.partner_id = h.partner_id
           JOIN partners p ON p.id = h.partner_id
           JOIN partner_tribes pt ON pt.id = h.partner_tribe_id
             AND pt.partner_id = h.partner_id AND pt.application_id = h.application_id
           JOIN users grantor ON grantor.id = h.authorized_by
            LEFT JOIN users revoker ON revoker.id = h.revoked_by
            WHERE h.social_tribe_id_snapshot = $1
            ORDER BY h.authorized_at DESC, h.id DESC`, [socialTribeId]);
        const links = await Promise.all(rows.rows.map(linkHistoryDto));
        return { links };
      });
    },

    async previewSocialTribePartnerLink({ sessionToken, userId, socialTribeId, applicationId, externalTribeId }) {
      userId = partnerUuid(userId); socialTribeId = partnerUuid(socialTribeId);
      applicationId = partnerUuid(applicationId);
      externalTribeId = parseExternalResourceId(externalTribeId, "tribo");
      return transaction(async client => {
        const socialTribe = await lockSocialModerator(client, { sessionToken, userId, socialTribeId });
        const application = await lockPartnerApplication(client, applicationId);
        const partnerTribe = await lockPartnerTribe(client, {
          partnerId: application.partner_id, applicationId: application.application_id, externalTribeId,
        }, "SHARE");
        if (!partnerTribe) throw notFound();
        if (partnerTribe.social_tribe_id) {
          throw new PartnerError(409, "social_link_exists", "Este recurso provisional já possui um vínculo social ativo.");
        }
        const activeHistory = await client.query(
          `SELECT 1 FROM partner_social_tribe_link_history
           WHERE partner_id = $1 AND application_id = $2 AND partner_tribe_id = $3 AND revoked_at IS NULL`,
          [application.partner_id, application.application_id, partnerTribe.id]);
        if (activeHistory.rowCount) throw new PartnerError(409, "social_link_exists", "Este recurso provisional já possui um vínculo social ativo.");

        await client.query("DELETE FROM partner_social_link_previews WHERE expires_at <= clock_timestamp()");
        const confirmationToken = randomBytes(32).toString("base64url");
        const expiresAt = new Date(Date.now() + 5 * 60 * 1000).toISOString();
        await client.query(
          `INSERT INTO partner_social_link_previews
             (token_hash, partner_id, application_id, partner_tribe_id, social_tribe_id, requested_by,
              external_tribe_id, partner_slug_snapshot, partner_name_snapshot, application_slug_snapshot,
              application_name_snapshot, partner_tribe_updated_at_snapshot, social_tribe_name_snapshot,
              social_tribe_moderator_snapshot, is_private_snapshot, expires_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16)`,
          [createHash("sha256").update(confirmationToken).digest("hex"), application.partner_id,
            application.application_id, partnerTribe.id, socialTribe.id, userId, externalTribeId,
            application.partner_slug, application.partner_name, application.application_slug,
            application.application_name, partnerTribe.updated_at, socialTribe.name,
            socialTribe.moderator_id, socialTribe.is_private, expiresAt]);
        return { confirmationToken, expiresAt, partner: { id: application.partner_id,
          slug: application.partner_slug, name: application.partner_name },
          application: { id: application.application_id, slug: application.application_slug,
            name: application.application_name },
          partnerTribe: { id: partnerTribe.id, externalTribeId, name: partnerTribe.name },
          socialTribe: { id: socialTribe.id, name: socialTribe.name, isPrivate: socialTribe.is_private } };
      });
    },

    async confirmSocialTribePartnerLink({ sessionToken, userId, socialTribeId, confirmationToken, confirmPrivateSharing = false }) {
      userId = partnerUuid(userId); socialTribeId = partnerUuid(socialTribeId);
      if (typeof confirmationToken !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(confirmationToken)) {
        throw partnerInvalid("Token de confirmação inválido.");
      }
      return transaction(async client => {
        const socialTribe = await lockSocialModerator(client, { sessionToken, userId, socialTribeId });
        const preview = (await client.query(
          `SELECT * FROM partner_social_link_previews
           WHERE token_hash = $1 AND requested_by = $2 AND social_tribe_id = $3
             AND expires_at > clock_timestamp()
           FOR UPDATE`,
          [createHash("sha256").update(confirmationToken).digest("hex"), userId, socialTribeId])).rows[0];
        if (!preview) throw new PartnerError(409, "social_link_preview_expired", "A confirmação expirou ou não pertence a este usuário e esta tribo. Gere uma nova prévia.");

        const application = await lockPartnerApplication(client, preview.application_id);
        const partnerTribe = await lockPartnerTribe(client, {
          partnerId: preview.partner_id, applicationId: preview.application_id,
          externalTribeId: preview.external_tribe_id,
        });
        const snapshotMatches = partnerTribe && partnerTribe.id === preview.partner_tribe_id &&
          partnerTribe.updated_at.getTime() === preview.partner_tribe_updated_at_snapshot.getTime() &&
          application.partner_slug === preview.partner_slug_snapshot && application.partner_name === preview.partner_name_snapshot &&
          application.application_slug === preview.application_slug_snapshot && application.application_name === preview.application_name_snapshot &&
          socialTribe.name === preview.social_tribe_name_snapshot && socialTribe.moderator_id === preview.social_tribe_moderator_snapshot &&
          socialTribe.is_private === preview.is_private_snapshot;
        if (!snapshotMatches || partnerTribe.social_tribe_id) {
          throw new PartnerError(409, "social_link_preview_changed", "Os dados do vínculo mudaram desde a prévia. Gere uma nova confirmação.");
        }
        if (socialTribe.is_private && confirmPrivateSharing !== true) {
          throw new PartnerError(400, "private_tribe_consent_required", "Confirme explicitamente o compartilhamento dos metadados da tribo privada.");
        }
        const existingSocialMapping = await client.query(
          `SELECT 1 FROM partner_tribes
           WHERE partner_id = $1 AND application_id = $2 AND social_tribe_id = $3 AND id <> $4
           FOR UPDATE`,
          [preview.partner_id, preview.application_id, socialTribe.id, preview.partner_tribe_id]);
        if (existingSocialMapping.rowCount) throw new PartnerError(409, "social_link_exists", "Esta aplicação já possui um recurso vinculado a esta tribo.");
        const history = (await client.query(
          `INSERT INTO partner_social_tribe_link_history
             (partner_id, application_id, partner_tribe_id, social_tribe_id_snapshot, authorized_by,
              private_at_authorization, private_data_consent)
           VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *`,
          [preview.partner_id, preview.application_id, preview.partner_tribe_id, socialTribe.id,
            userId, socialTribe.is_private, socialTribe.is_private && confirmPrivateSharing])).rows[0];
        const updatedMapping = await client.query(
          `UPDATE partner_tribes SET social_tribe_id = $4, updated_at = clock_timestamp()
           WHERE partner_id = $1 AND application_id = $2 AND id = $3 AND social_tribe_id IS NULL RETURNING id`,
          [preview.partner_id, preview.application_id, preview.partner_tribe_id, socialTribe.id]);
        if (!updatedMapping.rowCount) throw new PartnerError(409, "social_link_exists", "O recurso provisional já foi vinculado.");
        await audit(client, { partnerId: preview.partner_id, applicationId: preview.application_id,
          action: "tribe.social_linked", resourceId: preview.partner_tribe_id });
        await client.query("DELETE FROM partner_social_link_previews WHERE id = $1", [preview.id]);
        return { link: { id: history.id, socialTribeId: socialTribe.id, partnerTribeId: preview.partner_tribe_id,
          externalTribeId: preview.external_tribe_id, authorizedBy: userId, authorizedAt: history.authorized_at,
          privateAtAuthorization: history.private_at_authorization,
          privateDataConsent: history.private_data_consent } };
      });
    },

    async revokeSocialTribePartnerLink({ sessionToken, userId, socialTribeId, applicationId, externalTribeId }) {
      userId = partnerUuid(userId); socialTribeId = partnerUuid(socialTribeId);
      applicationId = partnerUuid(applicationId);
      externalTribeId = parseExternalResourceId(externalTribeId, "tribo");
      return transaction(async client => {
        await lockSocialModerator(client, { sessionToken, userId, socialTribeId });
        const application = await lockPartnerApplication(client, applicationId, {
          requireActive: false, requireOrganizerScope: false,
        });
        const partnerTribe = await lockPartnerTribe(client, {
          partnerId: application.partner_id, applicationId: application.application_id, externalTribeId,
        });
        if (!partnerTribe) throw notFound();
        if (!partnerTribe.social_tribe_id) {
          const previouslyRevoked = await client.query(
            `SELECT 1 FROM partner_social_tribe_link_history
             WHERE partner_id = $1 AND application_id = $2 AND partner_tribe_id = $3
               AND social_tribe_id_snapshot = $4 AND revoked_at IS NOT NULL
             LIMIT 1`,
            [application.partner_id, application.application_id, partnerTribe.id, socialTribeId]);
          if (!previouslyRevoked.rowCount) throw notFound();
          return { revoked: false };
        }
        if (partnerTribe.social_tribe_id !== socialTribeId) throw notFound();
        const history = (await client.query(
          `SELECT id FROM partner_social_tribe_link_history
           WHERE partner_id = $1 AND application_id = $2 AND partner_tribe_id = $3
             AND social_tribe_id_snapshot = $4 AND revoked_at IS NULL
           FOR UPDATE`,
          [application.partner_id, application.application_id, partnerTribe.id, socialTribeId])).rows[0];
        if (!history) throw new PartnerError(409, "social_link_integrity_error", "O vínculo não possui histórico de autorização válido.");
        await client.query(
          `UPDATE partner_social_tribe_link_history
           SET revoked_by = $2, revoked_at = clock_timestamp(), revocation_source = 'moderator'
           WHERE id = $1`, [history.id, userId]);
        await client.query(
          `UPDATE partner_tribes SET social_tribe_id = NULL, updated_at = clock_timestamp()
           WHERE id = $1 AND partner_id = $2 AND application_id = $3`,
          [partnerTribe.id, application.partner_id, application.application_id]);
        await audit(client, { partnerId: application.partner_id, applicationId: application.application_id,
          action: "tribe.social_link_revoked", resourceId: partnerTribe.id });
        return { revoked: true, revokedBy: userId, revokedAt: new Date().toISOString() };
      });
    },

    async listSocialTribePartnerOrganizerGrants({ sessionToken, userId, socialTribeId }) {
      userId = partnerUuid(userId); socialTribeId = partnerUuid(socialTribeId);
      return transaction(async client => {
        await lockSocialModerator(client, { sessionToken, userId, socialTribeId });
        const rows = await client.query(
          `SELECT g.*, pt.external_tribe_id
           FROM partner_organizer_grant_history g
           JOIN partner_tribes pt
             ON pt.id = g.partner_tribe_id AND pt.partner_id = g.partner_id
            AND pt.application_id = g.application_id
           WHERE g.social_tribe_id_snapshot = $1
           ORDER BY g.granted_at DESC, g.id DESC`, [socialTribeId]);
        return { grants: rows.rows.map(organizerGrantDto) };
      });
    },

    async issueSocialTribePartnerOrganizerGrant({ sessionToken, userId, socialTribeId,
      applicationId, externalTribeId, beneficiaryUserId }) {
      userId = partnerUuid(userId); socialTribeId = partnerUuid(socialTribeId);
      applicationId = partnerUuid(applicationId); beneficiaryUserId = partnerUuid(beneficiaryUserId);
      externalTribeId = parseExternalResourceId(externalTribeId, "tribo");
      return transaction(async client => {
        await lockSocialModerator(client, { sessionToken, userId, socialTribeId });
        const application = await lockPartnerApplication(client, applicationId, { requireOrganizerScope: false });
        if (!application.application_scopes.includes("organizer-grants:read")) {
          throw new PartnerError(409, "partner_application_scope_missing", "A aplicação não possui o escopo organizer-grants:read.");
        }
        const partnerTribe = await lockPartnerTribe(client, {
          partnerId: application.partner_id, applicationId: application.application_id, externalTribeId,
        });
        if (!partnerTribe || partnerTribe.social_tribe_id !== socialTribeId) throw notFound();
        const activeLink = await client.query(
          `SELECT id FROM partner_social_tribe_link_history
           WHERE partner_id = $1 AND application_id = $2 AND partner_tribe_id = $3
             AND social_tribe_id_snapshot = $4 AND revoked_at IS NULL
           FOR SHARE`, [application.partner_id, application.application_id, partnerTribe.id, socialTribeId]);
        if (!activeLink.rowCount) throw notFound();
        const beneficiary = await client.query(
          `SELECT u.id FROM users u
           JOIN tribe_memberships m ON m.user_id = u.id
           WHERE u.id = $1 AND m.tribe_id = $2 AND m.status = 'active'
           FOR SHARE OF u, m`, [beneficiaryUserId, socialTribeId]);
        if (!beneficiary.rowCount) {
          throw new PartnerError(404, "beneficiary_not_active_member", "Beneficiário não encontrado como membro ativo da tribo.");
        }
        const inserted = await client.query(
          `INSERT INTO partner_organizer_grant_history
             (partner_id, application_id, partner_tribe_id, social_tribe_id_snapshot,
              beneficiary_user_id, granted_by, capability)
           VALUES ($1, $2, $3, $4, $5, $6, 'organizer.manage')
           ON CONFLICT (partner_id, application_id, partner_tribe_id, social_tribe_id_snapshot, beneficiary_user_id, capability)
             WHERE revoked_at IS NULL DO NOTHING
           RETURNING *`,
          [application.partner_id, application.application_id, partnerTribe.id, socialTribeId, beneficiaryUserId, userId]);
        const row = inserted.rows[0] ?? (await client.query(
          `SELECT * FROM partner_organizer_grant_history
           WHERE partner_id = $1 AND application_id = $2 AND partner_tribe_id = $3
             AND social_tribe_id_snapshot = $4 AND beneficiary_user_id = $5
             AND capability = 'organizer.manage' AND revoked_at IS NULL
           FOR UPDATE`, [application.partner_id, application.application_id, partnerTribe.id, socialTribeId, beneficiaryUserId])).rows[0];
        if (inserted.rowCount) {
          await audit(client, { partnerId: application.partner_id, applicationId: application.application_id,
            action: "organizer.grant_issued", resourceId: partnerTribe.id });
        }
        return { grant: organizerGrantDto({ ...row, external_tribe_id: externalTribeId }), created: inserted.rowCount > 0 };
      });
    },

    async revokeSocialTribePartnerOrganizerGrant({ sessionToken, userId, socialTribeId, grantId }) {
      userId = partnerUuid(userId); socialTribeId = partnerUuid(socialTribeId); grantId = partnerUuid(grantId);
      return transaction(async client => {
        await lockSocialModerator(client, { sessionToken, userId, socialTribeId });
        const grant = (await client.query(
          `SELECT * FROM partner_organizer_grant_history
           WHERE id = $1 AND social_tribe_id_snapshot = $2 FOR UPDATE`, [grantId, socialTribeId])).rows[0];
        if (!grant) throw notFound();
        if (grant.revoked_at) return { revoked: false, grant: organizerGrantDto(grant) };
        const row = (await client.query(
          `UPDATE partner_organizer_grant_history
           SET revoked_by = $2, revoked_at = clock_timestamp(), revocation_source = 'moderator'
           WHERE id = $1 AND revoked_at IS NULL RETURNING *`, [grantId, userId])).rows[0];
        if (row) {
          await audit(client, { partnerId: grant.partner_id, applicationId: grant.application_id,
            action: "organizer.grant_revoked", resourceId: grant.partner_tribe_id });
        }
        return { revoked: Boolean(row), grant: organizerGrantDto(row ?? grant) };
      });
    },

    async listPartnerOrganizerGrants(client, principal, externalTribeId) {
      externalTribeId = parseExternalResourceId(externalTribeId, "tribo");
      const partnerTribe = await lockPartnerTribe(client, {
        partnerId: principal.partnerId, applicationId: principal.applicationId, externalTribeId,
      }, "SHARE");
      if (!partnerTribe) throw notFound();
      if (!partnerTribe.social_tribe_id) return { grants: [] };
      const activeLink = await client.query(
        `SELECT id FROM partner_social_tribe_link_history
         WHERE partner_id = $1 AND application_id = $2 AND partner_tribe_id = $3
           AND social_tribe_id_snapshot = $4 AND revoked_at IS NULL
         FOR SHARE`, [principal.partnerId, principal.applicationId, partnerTribe.id, partnerTribe.social_tribe_id]);
      if (!activeLink.rowCount) return { grants: [] };
      // Lock membership before grant rows. A concurrent departure either waits
      // until this authorized read finishes or revokes the grant before it can
      // be returned. Rejoining never reactivates a revoked grant.
      const candidates = await client.query(
        `SELECT beneficiary_user_id FROM partner_organizer_grant_history
         WHERE partner_id = $1 AND application_id = $2 AND partner_tribe_id = $3
           AND social_tribe_id_snapshot = $4 AND revoked_at IS NULL`,
        [principal.partnerId, principal.applicationId, partnerTribe.id, partnerTribe.social_tribe_id]);
      const candidateIds = candidates.rows.map(row => row.beneficiary_user_id);
      if (!candidateIds.length) return { grants: [] };
      const memberships = await client.query(
        `SELECT user_id FROM tribe_memberships
         WHERE tribe_id = $1 AND user_id = ANY($2::uuid[]) AND status = 'active'
         FOR SHARE`, [partnerTribe.social_tribe_id, candidateIds]);
      const activeMembers = memberships.rows.map(row => row.user_id);
      if (!activeMembers.length) return { grants: [] };
      const rows = await client.query(
        `SELECT g.id, g.beneficiary_user_id, g.capability, g.granted_at
         FROM partner_organizer_grant_history g
         WHERE g.partner_id = $1 AND g.application_id = $2 AND g.partner_tribe_id = $3
           AND g.social_tribe_id_snapshot = $4 AND g.revoked_at IS NULL
           AND g.beneficiary_user_id = ANY($5::uuid[])
         ORDER BY g.granted_at, g.id
         FOR SHARE OF g`,
        [principal.partnerId, principal.applicationId, partnerTribe.id, partnerTribe.social_tribe_id, activeMembers]);
      return { grants: rows.rows.map(row => ({
        id: row.id,
        beneficiaryUserId: row.beneficiary_user_id,
        capability: row.capability,
        grantedAt: row.granted_at,
      })) };
    },

    async createPartnerTribe(client, principal, tribe) {
      const inserted = await client.query(
        `INSERT INTO partner_tribes
           (partner_id, application_id, external_tribe_id, name, description, category, format, city, neighborhood)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
         ON CONFLICT (partner_id, application_id, external_tribe_id) DO NOTHING RETURNING *`,
        [principal.partnerId, principal.applicationId, tribe.externalTribeId, tribe.name, tribe.description,
          tribe.category, tribe.format, tribe.city, tribe.neighborhood]);
      const identity = inserted.rows[0] ?? (await client.query(
        `SELECT * FROM partner_tribes
         WHERE partner_id = $1 AND application_id = $2 AND external_tribe_id = $3 FOR UPDATE`,
        [principal.partnerId, principal.applicationId, tribe.externalTribeId])).rows[0];
      if (identity.name !== tribe.name || identity.description !== tribe.description || identity.category !== tribe.category ||
          identity.format !== tribe.format || identity.city !== tribe.city || identity.neighborhood !== tribe.neighborhood) {
        throw new PartnerError(409, "identity_conflict", "O identificador externo da tribo já está associado a outros dados.");
      }
      const row = await selectPartnerTribeRow(client, principal, tribe.externalTribeId, true);
      if (inserted.rowCount) await audit(client, { partnerId: principal.partnerId, applicationId: principal.applicationId,
        credentialId: principal.credentialId, action: "tribe.created", resourceId: row.id });
      return { tribe: partnerTribeDto(row), created: inserted.rowCount > 0 };
    },

    async getPartnerTribe(client, principal, externalTribeId) {
      const row = await selectPartnerTribeRow(client, principal, externalTribeId);
      return row ? partnerTribeDto(row) : null;
    },

    async updatePartnerTribe(client, principal, tribe) {
      const current = (await client.query(
        `SELECT * FROM partner_tribes
         WHERE partner_id = $1 AND application_id = $2 AND external_tribe_id = $3 FOR UPDATE`,
        [principal.partnerId, principal.applicationId, tribe.externalTribeId])).rows[0];
      if (!current) throw notFound();
      if (current.social_tribe_id) throw new PartnerError(409, "linked_tribe_read_only", "Tribos sociais vinculadas não podem ser alteradas pela API do parceiro.");
      const same = current.name === tribe.name && current.description === tribe.description && current.category === tribe.category &&
        current.format === tribe.format && current.city === tribe.city && current.neighborhood === tribe.neighborhood;
      if (!same) {
        const row = (await client.query(
          `UPDATE partner_tribes
           SET name = $4, description = $5, category = $6, format = $7, city = $8, neighborhood = $9, updated_at = clock_timestamp()
           WHERE partner_id = $1 AND application_id = $2 AND external_tribe_id = $3 RETURNING *`,
          [principal.partnerId, principal.applicationId, tribe.externalTribeId, tribe.name, tribe.description,
            tribe.category, tribe.format, tribe.city, tribe.neighborhood])).rows[0];
        await audit(client, { partnerId: principal.partnerId, applicationId: principal.applicationId,
          credentialId: principal.credentialId, action: "tribe.updated", resourceId: row.id });
        return partnerTribeDto(row);
      }
      return partnerTribeDto(current);
    },

    async createPartnerEvent(client, principal, event) {
      const tribe = (await client.query(
        `SELECT id FROM partner_tribes
         WHERE partner_id = $1 AND application_id = $2 AND external_tribe_id = $3 FOR SHARE`,
        [principal.partnerId, principal.applicationId, event.externalTribeId])).rows[0];
      if (!tribe) throw notFound();
      const inserted = await client.query(
        `INSERT INTO partner_events
           (partner_id, application_id, partner_tribe_id, external_event_id, title, description, starts_at, ends_at,
            location, location_lat, location_lon, cost, max_attendees)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
         ON CONFLICT (partner_id, external_event_id) DO NOTHING RETURNING id`,
        [principal.partnerId, principal.applicationId, tribe.id, event.externalEventId, event.title, event.description,
          event.startsAt, event.endsAt, event.location, event.lat, event.lon, event.cost, event.maxAttendees]);
      const row = await selectPartnerEventRow(client, principal, event.externalEventId, true);
      if (!row) throw notFound();
      if (row.application_id !== principal.applicationId) throw notFound();
      const equivalent = row.partner_tribe_id === tribe.id && row.title === event.title && row.description === event.description &&
        new Date(row.starts_at).getTime() === Date.parse(event.startsAt) &&
        (row.ends_at === null ? event.endsAt === null : new Date(row.ends_at).getTime() === Date.parse(event.endsAt)) &&
        row.location === event.location && row.location_lat === event.lat && row.location_lon === event.lon &&
        row.cost === event.cost && row.max_attendees === event.maxAttendees;
      if (!equivalent) throw new PartnerError(409, "identity_conflict", "O identificador externo do evento já está associado a outros dados.");
      if (inserted.rowCount) await audit(client, { partnerId: principal.partnerId, applicationId: principal.applicationId,
        credentialId: principal.credentialId, action: "event.created", resourceId: row.id });
      return { event: partnerEventDto(row), created: inserted.rowCount > 0 };
    },

    async getPartnerEvent(client, principal, externalEventId) {
      const row = await selectPartnerEventRow(client, principal, externalEventId);
      if (!row || row.application_id !== principal.applicationId) return null;
      return partnerEventDto(row);
    },

    async updatePartnerEvent(client, principal, externalEventId, event) {
      const current = await selectPartnerEventRow(client, principal, externalEventId, true);
      if (!current || current.application_id !== principal.applicationId) throw notFound();
      if (current.cancelled_at) throw new PartnerError(409, "event_cancelled", "Eventos cancelados são terminais e não podem ser alterados.");
      const scheduleChanged = new Date(current.starts_at).getTime() !== Date.parse(event.startsAt) ||
        (current.ends_at === null ? event.endsAt !== null : new Date(current.ends_at).getTime() !== Date.parse(event.endsAt));
      if (scheduleChanged) {
        if (current.participant_retention_at) {
          throw new PartnerError(409, "event_schedule_locked", "As datas de um evento com participantes são imutáveis após o término.");
        }
        const hasParticipants = await client.query(
          `SELECT 1 FROM partner_event_participants
           WHERE partner_id = $1 AND application_id = $2 AND partner_event_id = $3 LIMIT 1`,
          [principal.partnerId, principal.applicationId, current.id]);
        if (hasParticipants.rowCount) {
          const now = (await client.query("SELECT clock_timestamp() AS now")).rows[0].now;
          if ((current.ends_at ?? current.starts_at) <= now) {
            throw new PartnerError(409, "event_schedule_locked", "As datas de um evento com participantes são imutáveis após o término.");
          }
        }
      }
      const tribe = (await client.query(
        `SELECT id FROM partner_tribes
         WHERE partner_id = $1 AND application_id = $2 AND external_tribe_id = $3 FOR SHARE`,
        [principal.partnerId, principal.applicationId, event.externalTribeId])).rows[0];
      if (!tribe) throw notFound();
      if (current.partner_tribe_id !== tribe.id) {
        const participants = await client.query(
          "SELECT 1 FROM partner_event_participants WHERE partner_id = $1 AND application_id = $2 AND partner_event_id = $3 LIMIT 1",
          [principal.partnerId, principal.applicationId, current.id]);
        if (participants.rowCount) {
          throw new PartnerError(409, "event_has_participants", "Não é possível alterar a tribo de um evento que já possui participantes.");
        }
      }
      const same = current.partner_tribe_id === tribe.id && current.title === event.title && current.description === event.description &&
        new Date(current.starts_at).getTime() === Date.parse(event.startsAt) &&
        (current.ends_at === null ? event.endsAt === null : new Date(current.ends_at).getTime() === Date.parse(event.endsAt)) &&
        current.location === event.location && current.location_lat === event.lat && current.location_lon === event.lon &&
        current.cost === event.cost && current.max_attendees === event.maxAttendees;
      if (same) return partnerEventDto(current);
      let row;
      try {
        row = (await client.query(
          `UPDATE partner_events
           SET partner_tribe_id = $3, title = $4, description = $5, starts_at = $6, ends_at = $7,
               location = $8, location_lat = $9, location_lon = $10, cost = $11, max_attendees = $12,
               updated_at = clock_timestamp()
           WHERE partner_id = $1 AND application_id = $2 AND external_event_id = $13 RETURNING *`,
          [principal.partnerId, principal.applicationId, tribe.id, event.title, event.description, event.startsAt, event.endsAt,
            event.location, event.lat, event.lon, event.cost, event.maxAttendees, externalEventId])).rows[0];
      } catch (error) {
        if (error.constraint === "partner_event_retention_schedule_immutable") {
          throw new PartnerError(409, "event_schedule_locked", "As datas de um evento com participantes são imutáveis após o término.");
        }
        throw error;
      }
      await audit(client, { partnerId: principal.partnerId, applicationId: principal.applicationId,
        credentialId: principal.credentialId, action: "event.updated", resourceId: row.id });
      const targetTribe = (await client.query(
        `SELECT t.external_tribe_id, t.name AS tribe_name, link.id AS active_social_link_id,
                s.name AS social_tribe_name
         FROM partner_tribes t
         LEFT JOIN partner_social_tribe_link_history link
           ON link.partner_id = t.partner_id AND link.application_id = t.application_id
          AND link.partner_tribe_id = t.id AND link.social_tribe_id_snapshot = t.social_tribe_id
          AND link.revoked_at IS NULL
         LEFT JOIN tribes s ON s.id = link.social_tribe_id_snapshot WHERE t.id = $1`, [tribe.id])).rows[0];
      return partnerEventDto({ ...row, external_tribe_id: targetTribe.external_tribe_id,
        tribe_name: targetTribe.tribe_name, social_tribe_name: targetTribe.social_tribe_name,
        active_social_link_id: targetTribe.active_social_link_id, cancelled_at: null });
    },

    async cancelPartnerEvent(client, principal, externalEventId) {
      externalEventId = parseExternalResourceId(externalEventId, "evento");
      const row = (await client.query(
        `SELECT id, cancelled_at FROM partner_events
         WHERE partner_id = $1 AND application_id = $2 AND external_event_id = $3
         FOR UPDATE`, [principal.partnerId, principal.applicationId, externalEventId])).rows[0];
      if (!row) throw notFound();
      if (row.cancelled_at) return { cancelled: true, changed: false, cancelledAt: row.cancelled_at };
      const updated = (await client.query(
        `UPDATE partner_events SET cancelled_at = clock_timestamp(), updated_at = clock_timestamp()
         WHERE id = $1 AND cancelled_at IS NULL RETURNING cancelled_at`, [row.id])).rows[0];
      await audit(client, { partnerId: principal.partnerId, applicationId: principal.applicationId,
        credentialId: principal.credentialId, action: "event.cancelled", resourceId: row.id });
      return { cancelled: true, changed: true, cancelledAt: updated.cancelled_at };
    },

    async createPartnerEventParticipant(client, principal, externalEventId, externalParticipantId, rawClaimToken) {
      externalEventId = parseExternalResourceId(externalEventId, "evento");
      externalParticipantId = parseExternalResourceId(externalParticipantId, "participante");
      const claimToken = parsePartnerClaimToken(rawClaimToken);
      const event = (await client.query(
        `SELECT id, starts_at, ends_at, cancelled_at FROM partner_events
         WHERE partner_id = $1 AND application_id = $2 AND external_event_id = $3 FOR UPDATE`,
        [principal.partnerId, principal.applicationId, externalEventId])).rows[0];
      if (!event) throw notFound();
      const tokenHash = claimTokenHash(claimToken);
      const existing = (await client.query(
        `SELECT * FROM partner_event_participants
         WHERE partner_id = $1 AND application_id = $2 AND partner_event_id = $3
           AND external_participant_id = $4 FOR UPDATE`,
        [principal.partnerId, principal.applicationId, event.id, externalParticipantId])).rows[0];
      if (existing) {
        if (existing.claim_token_hash !== tokenHash) {
          throw new PartnerError(409, "identity_conflict", "O identificador externo já está associado a outro registro ou segredo.");
        }
        const result = (await client.query(
          `SELECT p.*, e.external_event_id, e.title AS event_title
           FROM partner_event_participants p JOIN partner_events e ON e.id = p.partner_event_id
           WHERE p.id = $1`, [existing.id])).rows[0];
        return { participant: partnerEventParticipantDto(result), created: false };
      }
      const eventEnd = event.ends_at ?? event.starts_at;
      if (event.cancelled_at || eventEnd <= new Date()) {
        throw new PartnerError(409, "event_not_active", "O evento cancelado ou encerrado não aceita novos participantes.");
      }
      let inserted;
      try { inserted = await client.query(
        `INSERT INTO partner_event_participants
           (partner_id, application_id, partner_event_id, external_participant_id,
            claim_token_hash, claim_expires_at)
         VALUES ($1, $2, $3, $4, $5, clock_timestamp() + INTERVAL '7 days')
         ON CONFLICT (partner_id, application_id, partner_event_id, external_participant_id) DO NOTHING
         RETURNING *`,
        [principal.partnerId, principal.applicationId, event.id, externalParticipantId, tokenHash]); }
      catch (error) {
        if (error.code === "23505") throw new PartnerError(409, "claim_token_conflict", "O segredo de resgate já está associado a outro registro.");
        throw error;
      }
      const participant = inserted.rows[0] ?? (await client.query(
        `SELECT * FROM partner_event_participants
         WHERE partner_id = $1 AND application_id = $2 AND partner_event_id = $3
           AND external_participant_id = $4 FOR UPDATE`,
        [principal.partnerId, principal.applicationId, event.id, externalParticipantId])).rows[0];
      if (participant.claim_token_hash !== tokenHash) {
        throw new PartnerError(409, "identity_conflict", "O identificador externo já está associado a outro registro ou segredo.");
      }
      if (inserted.rowCount) {
        try {
          const historicalHash = await client.query(
            `SELECT record_partner_participant_claim_token_hash($1, $2, $3) AS inserted`,
            [tokenHash, participant.id, participant.claim_token_version]);
          if (!historicalHash.rows[0].inserted) {
            throw new PartnerError(409, "claim_token_conflict", "O segredo de resgate já pertenceu a outro registro.");
          }
        } catch (error) {
          if (error.code === "23505") throw new PartnerError(409, "claim_token_conflict", "O segredo de resgate já pertenceu a outro registro.");
          throw error;
        }
        await participantHistory(client, { participant, action: "participant.created", actorType: "partner" });
        await audit(client, { partnerId: principal.partnerId, applicationId: principal.applicationId,
          credentialId: principal.credentialId, action: "participant.created", resourceId: participant.id,
          partnerEventId: event.id });
      }
      const result = (await client.query(
        `SELECT p.*, e.external_event_id, e.title AS event_title
         FROM partner_event_participants p JOIN partner_events e ON e.id = p.partner_event_id
         WHERE p.id = $1 AND p.partner_id = $2 AND p.application_id = $3`,
        [participant.id, principal.partnerId, principal.applicationId])).rows[0];
      return { participant: partnerEventParticipantDto(result), created: inserted.rowCount > 0 };
    },

    async selectPartnerParticipantRow(client, principal, participantId) {
      return (await client.query(
        `SELECT p.*, e.external_event_id, e.title AS event_title
         FROM partner_event_participants p
         JOIN partner_events e ON e.id = p.partner_event_id
           AND e.partner_id = p.partner_id AND e.application_id = p.application_id
         WHERE p.id = $1 AND p.partner_id = $2 AND p.application_id = $3`,
        [participantId, principal.partnerId, principal.applicationId])).rows[0];
    },

    async rotatePartnerParticipantClaimToken(client, principal, externalEventId, externalParticipantId, rawClaimToken) {
      externalEventId = parseExternalResourceId(externalEventId, "evento");
      externalParticipantId = parseExternalResourceId(externalParticipantId, "participante");
      const claimToken = parsePartnerClaimToken(rawClaimToken);
      const event = (await client.query(
        `SELECT id, starts_at, ends_at, cancelled_at FROM partner_events
         WHERE partner_id = $1 AND application_id = $2 AND external_event_id = $3 FOR UPDATE`,
        [principal.partnerId, principal.applicationId, externalEventId])).rows[0];
      if (!event) throw notFound();
      const participant = (await client.query(
        `SELECT * FROM partner_event_participants
         WHERE partner_id = $1 AND application_id = $2 AND partner_event_id = $3
           AND external_participant_id = $4 FOR UPDATE`,
        [principal.partnerId, principal.applicationId, event.id, externalParticipantId])).rows[0];
      if (!participant) throw notFound();
      if (event.cancelled_at || (event.ends_at ?? event.starts_at) <= new Date()) {
        throw new PartnerError(409, "event_not_active", "O evento cancelado ou encerrado não aceita novos resgates.");
      }
      if (participant.status !== "active") throw new PartnerError(409, "participant_cancelled", "O registro do participante foi cancelado.");
      if (participant.claim_token_used_at || participant.claimed_at) {
        throw new PartnerError(409, "participant_already_claimed", "O segredo já foi resgatado.");
      }
      const tokenHash = claimTokenHash(claimToken);
      if (participant.claim_token_hash === tokenHash) {
        return { participantId: participant.id, expiresAt: participant.claim_expires_at, rotated: false };
      }
      let updated;
      const nextVersion = Number(participant.claim_token_version) + 1;
      try {
        const historicalHash = await client.query(
          `SELECT record_partner_participant_claim_token_hash($1, $2, $3) AS inserted`,
          [tokenHash, participant.id, nextVersion]);
        if (!historicalHash.rows[0].inserted) {
          throw new PartnerError(409, "claim_token_conflict", "O segredo de resgate já pertenceu a outro registro ou versão.");
        }
        updated = (await client.query(
          `UPDATE partner_event_participants SET claim_token_hash = $2, claim_token_version = $3,
               claim_expires_at = clock_timestamp() + INTERVAL '7 days', updated_at = clock_timestamp()
           WHERE id = $1 RETURNING *`, [participant.id, tokenHash, nextVersion])).rows[0];
      }
      catch (error) {
        if (error instanceof PartnerError) throw error;
        if (error.code === "23505") throw new PartnerError(409, "claim_token_conflict", "O segredo de resgate já está associado a outro registro.");
        throw error;
      }
      await participantHistory(client, { participant: updated, action: "participant.claim_token_rotated", actorType: "partner" });
      await audit(client, { partnerId: principal.partnerId, applicationId: principal.applicationId,
        credentialId: principal.credentialId, action: "participant.claim_token_rotated", resourceId: participant.id,
        partnerEventId: event.id });
      return { participantId: participant.id, expiresAt: updated.claim_expires_at, rotated: true };
    },

    async cancelPartnerEventParticipant(client, principal, externalEventId, externalParticipantId) {
      externalEventId = parseExternalResourceId(externalEventId, "evento");
      externalParticipantId = parseExternalResourceId(externalParticipantId, "participante");
      const event = (await client.query(
        `SELECT id FROM partner_events
         WHERE partner_id = $1 AND application_id = $2 AND external_event_id = $3 FOR UPDATE`,
        [principal.partnerId, principal.applicationId, externalEventId])).rows[0];
      if (!event) throw notFound();
      const participant = (await client.query(
        `SELECT * FROM partner_event_participants
         WHERE partner_id = $1 AND application_id = $2 AND partner_event_id = $3
           AND external_participant_id = $4 FOR UPDATE`,
        [principal.partnerId, principal.applicationId, event.id, externalParticipantId])).rows[0];
      if (!participant) throw notFound();
      if (participant.status === "cancelled") return { cancelled: true, changed: false };
      const updated = (await client.query(
        `UPDATE partner_event_participants SET status = 'cancelled', updated_at = clock_timestamp()
         WHERE id = $1 RETURNING *`, [participant.id])).rows[0];
      await participantHistory(client, { participant: updated, action: "participant.cancelled", actorType: "partner" });
      await audit(client, { partnerId: principal.partnerId, applicationId: principal.applicationId,
        credentialId: principal.credentialId, action: "participant.cancelled", resourceId: participant.id,
        partnerEventId: event.id });
      return { cancelled: true, changed: true };
    },

    async previewPartnerEventParticipantClaim({ sessionToken, userId, rawClaimToken }) {
      userId = partnerUuid(userId);
      const claimToken = parsePartnerClaimToken(rawClaimToken);
      return transaction(async client => {
        await lockSocialSession(client, sessionToken, userId);
        const hash = claimTokenHash(claimToken);
        const lookup = (await client.query(
          `SELECT p.id, pt.social_tribe_id
           FROM partner_event_participants p
           JOIN partner_events e ON e.id = p.partner_event_id
           JOIN partner_tribes pt ON pt.id = e.partner_tribe_id
             AND pt.partner_id = e.partner_id AND pt.application_id = e.application_id
           JOIN partner_social_tribe_link_history l ON l.partner_id = pt.partner_id
             AND l.application_id = pt.application_id AND l.partner_tribe_id = pt.id
             AND l.social_tribe_id_snapshot = pt.social_tribe_id AND l.revoked_at IS NULL
           WHERE p.claim_token_hash = $1 AND p.status = 'active'
             AND p.claim_token_used_at IS NULL AND p.claim_expires_at > clock_timestamp()
             AND e.cancelled_at IS NULL AND pt.social_tribe_id IS NOT NULL`, [hash])).rows[0];
        if (!lookup) throw participantClaimInvalid();

        const socialTribe = (await client.query(
          "SELECT id, name, is_private FROM tribes WHERE id = $1 FOR SHARE", [lookup.social_tribe_id])).rows[0];
        if (!socialTribe) throw participantClaimInvalid();
        const application = await lockPartnerApplication(client,
          (await client.query(
            `SELECT application_id FROM partner_event_participants WHERE id = $1`, [lookup.id])).rows[0].application_id,
          { requireOrganizerScope: false });
        await client.query(
          `SELECT pt.id FROM partner_event_participants p
           JOIN partner_events e ON e.id = p.partner_event_id
           JOIN partner_tribes pt ON pt.id = e.partner_tribe_id
           WHERE p.id = $1 AND pt.social_tribe_id = $2 FOR SHARE OF pt`, [lookup.id, socialTribe.id]);
        await client.query(
          `SELECT l.id FROM partner_event_participants p
           JOIN partner_events e ON e.id = p.partner_event_id
           JOIN partner_tribes pt ON pt.id = e.partner_tribe_id
           JOIN partner_social_tribe_link_history l ON l.partner_tribe_id = pt.id
             AND l.social_tribe_id_snapshot = pt.social_tribe_id AND l.revoked_at IS NULL
           WHERE p.id = $1 AND l.social_tribe_id_snapshot = $2 FOR SHARE OF l`, [lookup.id, socialTribe.id]);
        await client.query(
          `SELECT e.id FROM partner_event_participants p JOIN partner_events e ON e.id = p.partner_event_id
           WHERE p.id = $1 FOR SHARE OF e`, [lookup.id]);
        await client.query("SELECT id FROM partner_event_participants WHERE id = $1 FOR UPDATE", [lookup.id]);
        const context = (await client.query(
          `SELECT p.*, e.id AS event_id, e.external_event_id, e.title AS event_title,
                  e.updated_at AS event_updated_at, e.cancelled_at,
                  pt.id AS partner_tribe_id, pt.social_tribe_id,
                  l.id AS social_link_id, l.revoked_at,
                  a.slug AS application_slug, a.name AS application_name,
                  partner.slug AS partner_slug, partner.name AS partner_name
           FROM partner_event_participants p
           JOIN partner_events e ON e.id = p.partner_event_id
             AND e.partner_id = p.partner_id AND e.application_id = p.application_id
           JOIN partner_tribes pt ON pt.id = e.partner_tribe_id
             AND pt.partner_id = e.partner_id AND pt.application_id = e.application_id
           JOIN partner_social_tribe_link_history l ON l.partner_id = pt.partner_id
             AND l.application_id = pt.application_id AND l.partner_tribe_id = pt.id
             AND l.social_tribe_id_snapshot = pt.social_tribe_id AND l.revoked_at IS NULL
           JOIN partner_applications a ON a.id = p.application_id
           JOIN partners partner ON partner.id = p.partner_id
           WHERE p.id = $1 AND p.claim_token_hash = $2`, [lookup.id, hash])).rows[0];
        if (!context || context.social_tribe_id !== socialTribe.id || context.cancelled_at ||
            context.status !== "active" || context.claim_token_used_at ||
            context.claim_expires_at <= new Date() || application.application_status !== "active" ||
            application.partner_status !== "active") throw participantClaimInvalid();

        const token = confirmationToken();
        const expiresAt = new Date(Date.now() + 5 * 60 * 1000).toISOString();
        await client.query(
          `INSERT INTO partner_event_participant_previews
             (confirmation_token_hash, participant_id, requested_by, partner_social_link_id,
              social_tribe_id_snapshot, partner_event_updated_at_snapshot, partner_event_title_snapshot,
              social_tribe_name_snapshot, social_tribe_private_snapshot, expires_at,
              claim_token_version, claim_token_hash)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
          [claimTokenHash(token), context.id, userId, context.social_link_id, socialTribe.id,
            context.event_updated_at, context.event_title, socialTribe.name, socialTribe.is_private, expiresAt,
            context.claim_token_version, context.claim_token_hash]);
        return {
          confirmationToken: token,
          expiresAt,
          partner: { slug: context.partner_slug, name: context.partner_name },
          application: { slug: context.application_slug, name: context.application_name },
          participant: { id: context.id, externalParticipantId: context.external_participant_id },
          event: { externalEventId: context.external_event_id, title: context.event_title },
          socialTribe: { id: socialTribe.id, name: socialTribe.name, isPrivate: socialTribe.is_private },
        };
      });
    },

    async confirmPartnerEventParticipantClaim({ sessionToken, userId, rawConfirmationToken }) {
      userId = partnerUuid(userId);
      if (typeof rawConfirmationToken !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(rawConfirmationToken)) {
        throw partnerInvalid("Token de confirmação inválido.");
      }
      return transaction(async client => {
        await lockSocialSession(client, sessionToken, userId);
        const confirmationHash = claimTokenHash(rawConfirmationToken);
        const preview = (await client.query(
          `SELECT * FROM partner_event_participant_previews
           WHERE confirmation_token_hash = $1 AND requested_by = $2 FOR UPDATE`,
          [confirmationHash, userId])).rows[0];
        if (!preview) throw new PartnerError(409, "participant_preview_expired", "A confirmação expirou ou não pertence a esta conta.");
        if (preview.consumed_at) {
          const claimed = (await client.query(
            `SELECT p.*, e.external_event_id, e.title AS event_title
             FROM partner_event_participants p JOIN partner_events e ON e.id = p.partner_event_id
             WHERE p.id = $1 AND p.confirmed_preview_id = $2`, [preview.participant_id, preview.id])).rows[0];
          if (preview.confirmed_by === userId && claimed) return { participant: partnerEventParticipantDto(claimed), linked: true };
          throw new PartnerError(409, "participant_preview_expired", "A confirmação expirou ou já foi utilizada.");
        }
        if (preview.expires_at <= new Date()) {
          throw new PartnerError(409, "participant_preview_expired", "A confirmação expirou. Gere uma nova prévia.");
        }
        const socialTribe = (await client.query(
          "SELECT id, name, is_private FROM tribes WHERE id = $1 FOR SHARE", [preview.social_tribe_id_snapshot])).rows[0];
        if (!socialTribe) throw participantClaimInvalid();
        const lookup = (await client.query(
          `SELECT p.application_id FROM partner_event_participants p WHERE p.id = $1`, [preview.participant_id])).rows[0];
        if (!lookup) throw participantClaimInvalid();
        const application = await lockPartnerApplication(client, lookup.application_id, { requireOrganizerScope: false });
        await client.query(
          `SELECT pt.id FROM partner_event_participants p
           JOIN partner_events e ON e.id = p.partner_event_id
           JOIN partner_tribes pt ON pt.id = e.partner_tribe_id
           WHERE p.id = $1 AND pt.social_tribe_id = $2 FOR SHARE OF pt`, [preview.participant_id, socialTribe.id]);
        await client.query(
          `SELECT l.id FROM partner_event_participants p
           JOIN partner_events e ON e.id = p.partner_event_id
           JOIN partner_tribes pt ON pt.id = e.partner_tribe_id
           JOIN partner_social_tribe_link_history l ON l.partner_tribe_id = pt.id
             AND l.social_tribe_id_snapshot = pt.social_tribe_id AND l.revoked_at IS NULL
           WHERE p.id = $1 AND l.id = $2 FOR SHARE OF l`, [preview.participant_id, preview.partner_social_link_id]);
        await client.query(
          `SELECT e.id FROM partner_event_participants p JOIN partner_events e ON e.id = p.partner_event_id
           WHERE p.id = $1 FOR SHARE OF e`, [preview.participant_id]);
        await client.query("SELECT id FROM partner_event_participants WHERE id = $1 FOR UPDATE", [preview.participant_id]);
        const context = (await client.query(
          `SELECT p.*, e.id AS event_id, e.external_event_id, e.title AS event_title,
                  e.updated_at AS event_updated_at, e.cancelled_at,
                  pt.id AS partner_tribe_id, pt.social_tribe_id,
                  l.id AS social_link_id, l.revoked_at,
                  a.id AS app_id, a.status AS application_status, partner.status AS partner_status
           FROM partner_event_participants p
           JOIN partner_events e ON e.id = p.partner_event_id
             AND e.partner_id = p.partner_id AND e.application_id = p.application_id
           JOIN partner_tribes pt ON pt.id = e.partner_tribe_id
             AND pt.partner_id = e.partner_id AND pt.application_id = e.application_id
           JOIN partner_social_tribe_link_history l ON l.partner_id = pt.partner_id
             AND l.application_id = pt.application_id AND l.partner_tribe_id = pt.id
             AND l.social_tribe_id_snapshot = pt.social_tribe_id AND l.revoked_at IS NULL
           JOIN partner_applications a ON a.id = p.application_id
           JOIN partners partner ON partner.id = p.partner_id
           WHERE p.id = $1 AND l.id = $2`,
          [preview.participant_id, preview.partner_social_link_id])).rows[0];
         if (!context || context.social_tribe_id !== socialTribe.id || context.cancelled_at ||
             context.status !== "active" || context.claim_token_used_at ||
             context.claim_token_version !== preview.claim_token_version ||
             context.claim_token_hash !== preview.claim_token_hash ||
             context.claim_expires_at <= new Date() || context.claimed_at ||
            context.event_updated_at.getTime() !== preview.partner_event_updated_at_snapshot.getTime() ||
            context.event_title !== preview.partner_event_title_snapshot || socialTribe.name !== preview.social_tribe_name_snapshot ||
            socialTribe.is_private !== preview.social_tribe_private_snapshot ||
            context.application_status !== "active" || context.partner_status !== "active" ||
            application.application_status !== "active" || application.partner_status !== "active") {
          throw new PartnerError(409, "participant_preview_changed", "Os dados ou permissões mudaram desde a prévia. Gere uma nova.");
        }
        const updated = (await client.query(
          `UPDATE partner_event_participants
           SET claim_token_used_at = clock_timestamp(), claimed_user_id = $2, claimed_at = clock_timestamp(),
               claimed_social_link_id = $3, claimed_social_tribe_id_snapshot = $4,
               claimed_social_tribe_name_snapshot = $5, confirmed_preview_id = $6,
               updated_at = clock_timestamp()
           WHERE id = $1 AND claim_token_used_at IS NULL AND claimed_at IS NULL
           RETURNING *`, [context.id, userId, preview.partner_social_link_id, socialTribe.id,
            socialTribe.name, preview.id])).rows[0];
        if (!updated) throw new PartnerError(409, "participant_already_claimed", "O ingresso já foi associado a uma conta.");
        await client.query(
          "UPDATE partner_event_participant_previews SET consumed_at = clock_timestamp(), confirmed_by = $2 WHERE id = $1",
          [preview.id, userId]);
        await participantHistory(client, { participant: updated, action: "participant.account_linked",
          actorType: "user", actorUserId: userId, socialTribeId: socialTribe.id });
        await audit(client, { partnerId: updated.partner_id, applicationId: updated.application_id,
          action: "participant.account_linked", resourceId: updated.id, partnerEventId: updated.partner_event_id });
        const participant = (await client.query(
          `SELECT p.*, e.external_event_id, e.title AS event_title
           FROM partner_event_participants p JOIN partner_events e ON e.id = p.partner_event_id
           WHERE p.id = $1`, [updated.id])).rows[0];
        return { participant: partnerEventParticipantDto(participant), linked: true };
      });
    },

    async listMyPartnerEventParticipants({ sessionToken, userId }) {
      userId = partnerUuid(userId);
      return transaction(async client => {
        await lockSocialSession(client, sessionToken, userId);
        const rows = await client.query(
          `SELECT p.id, p.external_participant_id, p.status, p.created_at, p.claimed_at,
                  p.account_unlinked_at, p.claimed_social_tribe_name_snapshot,
                  e.external_event_id, e.title AS event_title, e.cancelled_at,
                  partner.name AS partner_name, a.name AS application_name,
                  EXISTS (
                    SELECT 1 FROM partner_social_tribe_link_history l
                    JOIN partner_events le ON le.id = p.partner_event_id
                    JOIN partner_tribes lt ON lt.id = le.partner_tribe_id
                    WHERE l.id = p.claimed_social_link_id AND l.revoked_at IS NULL
                      AND l.social_tribe_id_snapshot = lt.social_tribe_id
                  ) AS social_link_active,
                  EXISTS (
                    SELECT 1 FROM tribe_memberships m
                    WHERE m.tribe_id = p.claimed_social_tribe_id_snapshot
                      AND m.user_id = $1 AND m.status = 'active'
                  ) AS is_member
           FROM partner_event_participants p
           JOIN partner_events e ON e.id = p.partner_event_id
           JOIN partner_applications a ON a.id = p.application_id
           JOIN partners partner ON partner.id = p.partner_id
           WHERE p.claimed_user_id = $1 AND p.account_unlinked_at IS NULL
           ORDER BY p.claimed_at DESC, p.id`, [userId]);
        return { participants: rows.rows.map(row => ({
          id: row.id,
          event: { externalEventId: row.external_event_id, title: row.event_title },
          partner: { name: row.partner_name, applicationName: row.application_name },
          socialTribeName: row.claimed_social_tribe_name_snapshot,
          status: row.cancelled_at ? "event_cancelled" : row.status,
          socialLinkActive: row.social_link_active,
          isMember: row.is_member,
          claimedAt: row.claimed_at,
        })) };
      });
    },

    async unlinkMyPartnerEventParticipant({ sessionToken, userId, participantId }) {
      userId = partnerUuid(userId); participantId = partnerUuid(participantId);
      return transaction(async client => {
        await lockSocialSession(client, sessionToken, userId);
        const initial = (await client.query(
          `SELECT claimed_social_tribe_id_snapshot, partner_event_id FROM partner_event_participants
           WHERE id = $1 AND (claimed_user_id = $2 OR account_unlinked_by = $2)`, [participantId, userId])).rows[0];
        if (!initial) throw participantNotFound();
        if (initial.claimed_social_tribe_id_snapshot) {
          await client.query("SELECT id FROM tribes WHERE id = $1 FOR UPDATE", [initial.claimed_social_tribe_id_snapshot]);
        }
        await client.query("SELECT id FROM partner_events WHERE id = $1 FOR SHARE", [initial.partner_event_id]);
        const participant = (await client.query(
          `SELECT p.* FROM partner_event_participants p
           WHERE p.id = $1 AND (p.claimed_user_id = $2 OR p.account_unlinked_by = $2)
           FOR UPDATE`, [participantId, userId])).rows[0];
        if (!participant) throw participantNotFound();
        if (participant.account_unlinked_at) return { unlinked: false };
        const updated = (await client.query(
          `UPDATE partner_event_participants
           SET claimed_user_id = NULL, account_unlinked_at = clock_timestamp(), account_unlinked_by = $2,
               updated_at = clock_timestamp()
           WHERE id = $1 AND claimed_user_id = $2 AND account_unlinked_at IS NULL RETURNING *`,
          [participantId, userId])).rows[0];
        if (!updated) return { unlinked: false };
        await participantHistory(client, { participant: updated, action: "participant.account_unlinked",
          actorType: "user", actorUserId: userId, socialTribeId: participant.claimed_social_tribe_id_snapshot });
        await audit(client, { partnerId: participant.partner_id, applicationId: participant.application_id,
          action: "participant.account_unlinked", resourceId: participant.id,
          partnerEventId: participant.partner_event_id });
        return { unlinked: true };
      });
    },

    async joinPartnerEventParticipantTribe({ sessionToken, userId, participantId, password }) {
      userId = partnerUuid(userId); participantId = partnerUuid(participantId);
      return transaction(async client => {
        await lockSocialSession(client, sessionToken, userId);
        const initial = (await client.query(
          `SELECT claimed_social_tribe_id_snapshot, partner_event_id, application_id, claimed_social_link_id
           FROM partner_event_participants
           WHERE id = $1 AND claimed_user_id = $2 AND account_unlinked_at IS NULL`,
          [participantId, userId])).rows[0];
        if (!initial) throw participantNotFound();
        const tribe = (await client.query(
          "SELECT id, name, is_private, password_hash FROM tribes WHERE id = $1 FOR UPDATE",
          [initial.claimed_social_tribe_id_snapshot])).rows[0];
        if (!tribe) throw participantNotFound();
        const application = await lockPartnerApplication(client, initial.application_id, { requireActive: false, requireOrganizerScope: false });
        await client.query(
          `SELECT pt.id FROM partner_events e JOIN partner_tribes pt ON pt.id = e.partner_tribe_id
           WHERE e.id = $1 FOR SHARE OF pt`, [initial.partner_event_id]);
        if (initial.claimed_social_link_id) {
          await client.query("SELECT id FROM partner_social_tribe_link_history WHERE id = $1 FOR SHARE", [initial.claimed_social_link_id]);
        }
        await client.query("SELECT id FROM partner_events WHERE id = $1 FOR SHARE", [initial.partner_event_id]);
        const participant = (await client.query(
          `SELECT * FROM partner_event_participants
           WHERE id = $1 AND claimed_user_id = $2 AND account_unlinked_at IS NULL FOR UPDATE`,
          [participantId, userId])).rows[0];
        if (!participant) throw participantNotFound();
        const currentMember = await client.query(
          "SELECT 1 FROM tribe_memberships WHERE tribe_id = $1 AND user_id = $2 AND status = 'active' FOR SHARE",
          [tribe.id, userId]);
        if (currentMember.rowCount) return { isMember: true, joined: false, tribeName: participant.claimed_social_tribe_name_snapshot };
        const context = (await client.query(
          `SELECT p.*, e.cancelled_at, pt.social_tribe_id, l.id AS active_link_id,
                  a.status AS application_status, partner.status AS partner_status
           FROM partner_event_participants p
           JOIN partner_events e ON e.id = p.partner_event_id
           JOIN partner_tribes pt ON pt.id = e.partner_tribe_id
             AND pt.partner_id = e.partner_id AND pt.application_id = e.application_id
           JOIN partner_social_tribe_link_history l ON l.partner_id = pt.partner_id
             AND l.application_id = pt.application_id AND l.partner_tribe_id = pt.id
             AND l.social_tribe_id_snapshot = pt.social_tribe_id AND l.revoked_at IS NULL
           JOIN partner_applications a ON a.id = p.application_id
           JOIN partners partner ON partner.id = p.partner_id
           WHERE p.id = $1 AND p.claimed_user_id = $2 AND p.account_unlinked_at IS NULL`, [participantId, userId])).rows[0];
        if (!context || context.status !== "active" || context.cancelled_at ||
            context.social_tribe_id !== tribe.id || context.claimed_social_tribe_id_snapshot !== tribe.id ||
            context.claimed_social_link_id !== context.active_link_id ||
            context.application_status !== "active" || context.partner_status !== "active" ||
            application.application_status !== "active" || application.partner_status !== "active") {
          throw new PartnerError(409, "participant_not_eligible", "Este ingresso não está mais elegível para uma nova entrada na tribo.");
        }
        if (tribe.is_private && (typeof password !== "string" || !password || password.length > 128 ||
            !(await verifyPassword(password, tribe.password_hash)))) {
          throw new PartnerError(403, "private_tribe_access_denied", "A senha ou os requisitos atuais da tribo não foram atendidos.");
        }
        await client.query(
          `INSERT INTO tribe_memberships (tribe_id, user_id, status, joined_at, left_at)
           VALUES ($1, $2, 'active', clock_timestamp(), NULL)
           ON CONFLICT (tribe_id, user_id) DO UPDATE
             SET status = 'active', joined_at = clock_timestamp(), left_at = NULL
           WHERE tribe_memberships.status <> 'active'`, [tribe.id, userId]);
        await participantHistory(client, { participant: context, action: "participant.tribe_joined",
          actorType: "user", actorUserId: userId, socialTribeId: tribe.id });
        await audit(client, { partnerId: context.partner_id, applicationId: context.application_id,
          action: "participant.tribe_joined", resourceId: context.id,
          partnerEventId: context.partner_event_id });
        return { isMember: true, joined: true, tribeName: tribe.name };
      });
    },

    async deleteExpiredPartnerParticipantData() {
      return transaction(async client => {
        await client.query("SELECT pg_advisory_xact_lock(718223, 1009)");
        const startedAt = (await client.query("SELECT clock_timestamp() AS started_at")).rows[0].started_at;
        const expiredPreviews = await client.query(
          `DELETE FROM partner_event_participant_previews
           WHERE expires_at < clock_timestamp() - INTERVAL '7 days'
           RETURNING id`);
        await client.query(
          `UPDATE partner_events event
           SET participant_retention_at = CASE
             WHEN event.cancelled_at IS NOT NULL
               THEN LEAST(COALESCE(event.ends_at, event.starts_at), event.cancelled_at)
             ELSE COALESCE(event.ends_at, event.starts_at)
           END
           WHERE event.participant_retention_at IS NULL
             AND (event.cancelled_at IS NOT NULL
                  OR COALESCE(event.ends_at, event.starts_at) <= clock_timestamp())
             AND EXISTS (
               SELECT 1 FROM partner_event_participants participant
               WHERE participant.partner_event_id = event.id
             )`);
        const expired = await client.query(
          `SELECT p.id
           FROM partner_event_participants p
           JOIN partner_events e ON e.id = p.partner_event_id
           WHERE e.participant_retention_at + INTERVAL '90 days' <= clock_timestamp()
           FOR UPDATE OF p SKIP LOCKED`);
        const participantIds = expired.rows.map(row => row.id);
        let historyRowsAggregated = 0;
        let auditRowsAggregated = 0;
        let participantsProcessed = 0;
        if (participantIds.length) {
          await client.query(
            `INSERT INTO partner_event_participant_audit_aggregates
               (partner_id, application_id, partner_event_id, action, source, occurrence_count)
             SELECT partner_id, application_id, partner_event_id, action,
                    'participant_history', count(*)
             FROM partner_event_participant_history
             WHERE participant_id = ANY($1::uuid[]) AND action LIKE 'participant.%'
             GROUP BY partner_id, application_id, partner_event_id, action
             ON CONFLICT (partner_id, application_id, partner_event_id, action, source)
               WHERE partner_event_id IS NOT NULL
               DO UPDATE SET occurrence_count = partner_event_participant_audit_aggregates.occurrence_count + EXCLUDED.occurrence_count`,
            [participantIds]);
          historyRowsAggregated = (await client.query(
            `DELETE FROM partner_event_participant_history
             WHERE participant_id = ANY($1::uuid[]) AND action LIKE 'participant.%'
             RETURNING id`, [participantIds])).rowCount;

          await client.query(
            `UPDATE partner_audit_logs audit
             SET partner_event_id = participant.partner_event_id
             FROM partner_event_participants participant
             WHERE participant.id = audit.resource_id
               AND participant.id = ANY($1::uuid[])
               AND audit.action LIKE 'participant.%'
               AND audit.partner_event_id IS NULL`, [participantIds]);
          await client.query(
            `INSERT INTO partner_event_participant_audit_aggregates
               (partner_id, application_id, partner_event_id, action, source, occurrence_count)
             SELECT partner_id, application_id, partner_event_id, action, 'partner_audit', count(*)
             FROM partner_audit_logs
             WHERE resource_id = ANY($1::uuid[]) AND action LIKE 'participant.%'
               AND partner_event_id IS NOT NULL
             GROUP BY partner_id, application_id, partner_event_id, action
             ON CONFLICT (partner_id, application_id, partner_event_id, action, source)
               WHERE partner_event_id IS NOT NULL
               DO UPDATE SET occurrence_count = partner_event_participant_audit_aggregates.occurrence_count + EXCLUDED.occurrence_count`,
            [participantIds]);
          await client.query(
            `INSERT INTO partner_event_participant_audit_aggregates
               (partner_id, application_id, partner_event_id, action, source, occurrence_count)
             SELECT partner_id, application_id, NULL, action, 'partner_audit', count(*)
             FROM partner_audit_logs
             WHERE resource_id = ANY($1::uuid[]) AND action LIKE 'participant.%'
               AND partner_event_id IS NULL
             GROUP BY partner_id, application_id, action
             ON CONFLICT (partner_id, application_id, action, source)
               WHERE partner_event_id IS NULL
               DO UPDATE SET occurrence_count = partner_event_participant_audit_aggregates.occurrence_count + EXCLUDED.occurrence_count`,
            [participantIds]);
          auditRowsAggregated = (await client.query(
            `DELETE FROM partner_audit_logs
             WHERE resource_id = ANY($1::uuid[]) AND action LIKE 'participant.%'
             RETURNING id`, [participantIds])).rowCount;
          participantsProcessed = (await client.query(
            `DELETE FROM partner_event_participants
             WHERE id = ANY($1::uuid[]) RETURNING id`, [participantIds])).rowCount;
        }
        const run = (await client.query(
          `INSERT INTO partner_participant_retention_runs
             (started_at, completed_at, duration_ms, previews_deleted, participants_processed,
              history_rows_aggregated, audit_rows_aggregated)
           SELECT $1, clock_timestamp(),
                  GREATEST(0, (EXTRACT(EPOCH FROM (clock_timestamp() - $1)) * 1000)::bigint),
                  $2, $3, $4, $5
           RETURNING started_at, completed_at, duration_ms, previews_deleted,
                     participants_processed, history_rows_aggregated, audit_rows_aggregated`,
          [startedAt, expiredPreviews.rowCount, participantsProcessed, historyRowsAggregated, auditRowsAggregated])).rows[0];
        return { ...run };
      });
    },

    // Future resource mutations must execute inside work(client, principal), so
    // revocation cannot race the authorization check and the resource mutation.
    async withAuthorization(token, requiredScopes, work) {
      const parsed = parsePartnerKey(token);
      if (!parsed) throw unauthenticated();
      const outcome = await transaction(async client => {
        const lookup = await client.query("SELECT partner_id, application_id FROM partner_api_keys WHERE id = $1", [parsed.id]);
        if (!lookup.rowCount) throw unauthenticated();
        const partner = (await client.query("SELECT * FROM partners WHERE id = $1 FOR SHARE", [lookup.rows[0].partner_id])).rows[0];
        const app = (await client.query("SELECT * FROM partner_applications WHERE id = $1 AND partner_id = $2 FOR SHARE", [lookup.rows[0].application_id, partner.id])).rows[0];
        const key = (await client.query("SELECT *, expires_at > clock_timestamp() AS unexpired FROM partner_api_keys WHERE id = $1 FOR SHARE", [parsed.id])).rows[0];
        if (!key || !matchesPartnerKey(token, key.token_hash) || !key.unexpired || key.revoked_at || partner.status !== "active" || app.status !== "active") throw unauthenticated();
        const scopes = key.scopes.filter(scope => app.scopes.includes(scope));
        if (requiredScopes.some(scope => !scopes.includes(scope))) throw new PartnerError(403, "insufficient_scope", "A credencial não possui a permissão necessária.");
        const budget = await client.query(
          `INSERT INTO partner_rate_limits (application_id, window_start, request_count)
           VALUES ($1, date_trunc('minute', clock_timestamp()), 1)
           ON CONFLICT (application_id) DO UPDATE SET
             window_start = date_trunc('minute', clock_timestamp()),
             request_count = CASE WHEN partner_rate_limits.window_start = date_trunc('minute', clock_timestamp())
               THEN partner_rate_limits.request_count + 1 ELSE 1 END
           RETURNING request_count, GREATEST(1, CEIL(EXTRACT(EPOCH FROM window_start + INTERVAL '1 minute' - clock_timestamp())))::int AS retry_after`, [app.id]);
        if (budget.rows[0].request_count > app.requests_per_minute) {
          // Throwing rolls back the increment; repeated denials keep a bounded counter.
          throw new PartnerError(429, "rate_limit_exceeded", "Limite de requisições da integração excedido.", { "Retry-After": String(budget.rows[0].retry_after) });
        }
        // The request may have waited on the shared rate-limit row. Recheck
        // wall-clock expiration after all waits, before entering resource work.
        const validity = await client.query("SELECT expires_at > clock_timestamp() AS unexpired FROM partner_api_keys WHERE id = $1", [key.id]);
        if (!validity.rows[0].unexpired) throw unauthenticated();
        const principal = { partnerId: partner.id, applicationId: app.id, credentialId: key.id, scopes,
          partner: partnerDto(partner), application: applicationDto(app), credential: keyDto(key) };
        // Failed resource mutations roll back, but still consume the request
        // budget. Otherwise repeated invalid writes could bypass the limiter.
        await client.query("SAVEPOINT partner_operation");
        try {
          const value = await work(client, principal);
          await client.query("RELEASE SAVEPOINT partner_operation");
          return { value };
        } catch (error) {
          await client.query("ROLLBACK TO SAVEPOINT partner_operation");
          return { error };
        }
      });
      if (outcome.error) throw outcome.error;
      return outcome.value;
    },
  };
}

export const partnerStore = createPartnerStore();
export async function closePartnerStore() { await pool.end(); }
