import "./load-env.mjs";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { digestSessionToken, verifyPassword } from "./security.mjs";
import { getObjectStorage } from "./object-storage.mjs";
import { SESSION_MAX_AGE_SECONDS, SESSION_RENEW_THRESHOLD_SECONDS } from "./session-policy.mjs";

const { Pool } = pg;
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const migrationsDirectory = path.join(path.dirname(fileURLToPath(import.meta.url)), "migrations");

export async function initializeSocialStore() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      name TEXT PRIMARY KEY,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
    )
  `);
  const files = (await readdir(migrationsDirectory)).filter((file) => file.endsWith(".sql")).sort();
  for (const name of files) {
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("SELECT pg_advisory_xact_lock(712034)");
      const applied = await client.query("SELECT 1 FROM schema_migrations WHERE name = $1", [name]);
      if (applied.rowCount === 0) {
        await client.query(await readFile(path.join(migrationsDirectory, name), "utf8"));
        await client.query("INSERT INTO schema_migrations (name) VALUES ($1)", [name]);
      }
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }
  await pool.query("DELETE FROM user_sessions WHERE expires_at <= CURRENT_TIMESTAMP");
  await pool.query("DELETE FROM registration_tokens WHERE expires_at <= CURRENT_TIMESTAMP");
  await pool.query("DELETE FROM password_reset_tokens WHERE expires_at <= CURRENT_TIMESTAMP");
  await pool.query("DELETE FROM email_queue WHERE status IN ('sent', 'failed', 'skipped') AND created_at < CURRENT_TIMESTAMP - INTERVAL '30 days'");
}

export async function createRegistrationToken({ email, tokenHash, expiresAt, invitationId = null, queueId = null }) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [email]);
    const { rowCount } = await client.query("SELECT 1 FROM users WHERE email = $1", [email]);
    if (rowCount > 0) {
      await client.query("COMMIT");
      return false;
    }
    if (queueId) {
      const queued = await client.query("SELECT invitation_id FROM email_queue WHERE id = $1", [queueId]);
      invitationId = queued.rows[0]?.invitation_id ?? null;
    }
    await client.query("DELETE FROM registration_tokens WHERE expires_at <= CURRENT_TIMESTAMP");
    await client.query(
      "INSERT INTO registration_tokens (token_hash, email, expires_at, invitation_id) VALUES ($1, $2, $3, $4)",
      [tokenHash, email, expiresAt, invitationId]
    );
    await client.query("COMMIT");
    return true;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

export async function deleteRegistrationToken(tokenHash) {
  await pool.query("DELETE FROM registration_tokens WHERE token_hash = $1", [tokenHash]);
}

export async function createPasswordResetToken({ email, tokenHash, expiresAt }) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [email]);
    const { rows: users } = await client.query("SELECT id FROM users WHERE email = $1", [email]);
    if (users.length === 0) {
      await client.query("COMMIT");
      return null;
    }

    await client.query("DELETE FROM password_reset_tokens WHERE expires_at <= CURRENT_TIMESTAMP");
    await client.query(
      "INSERT INTO password_reset_tokens (token_hash, user_id, expires_at) VALUES ($1, $2, $3)",
      [tokenHash, users[0].id, expiresAt]
    );
    await client.query("COMMIT");
    return true;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

export async function deletePasswordResetToken(tokenHash) {
  await pool.query("DELETE FROM password_reset_tokens WHERE token_hash = $1", [tokenHash]);
}

export async function enqueueEmail({ email, kind, invitationId = null }) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [`${kind}:${email}`]);
    if (kind === "registration" && invitationId) await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [email]);
    const { rows: existing } = await client.query(
      `SELECT id, status FROM email_queue
       WHERE kind = $1 AND email = $2
         AND (status IN ('pending', 'processing') OR created_at > CURRENT_TIMESTAMP - INTERVAL '1 minute')
       LIMIT 1`,
      [kind, email]
    );
    if (existing.length > 0) {
      if (kind === "registration" && invitationId) {
        await client.query("UPDATE email_queue SET invitation_id = $2 WHERE id = $1", [existing[0].id, invitationId]);
        await client.query("UPDATE registration_tokens SET invitation_id = $2 WHERE email = $1 AND expires_at > CURRENT_TIMESTAMP", [email, invitationId]);
      }
      await client.query("COMMIT");
      return existing[0];
    }
    const { rows } = await client.query(
      "INSERT INTO email_queue (email, kind, invitation_id) VALUES ($1, $2, $3) RETURNING id, status",
      [email, kind, invitationId]
    );
    await client.query("COMMIT");
    return rows[0];
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

export async function acquireEmailQueueWorkerLock() {
  const client = await pool.connect();
  try {
    const { rows } = await client.query("SELECT pg_try_advisory_lock(712035) AS acquired");
    if (!rows[0].acquired) {
      client.release();
      return null;
    }
    return client;
  } catch (error) {
    client.release();
    throw error;
  }
}

export async function releaseEmailQueueWorkerLock(client) {
  try {
    await client.query("SELECT pg_advisory_unlock(712035)");
  } finally {
    client.release();
  }
}

export async function getEmailQueuePause() {
  const { rows } = await pool.query(
    "SELECT paused_until, pause_reason FROM email_queue_state WHERE singleton = TRUE"
  );
  const state = rows[0];
  if (!state?.paused_until) return null;
  if (new Date(state.paused_until) <= new Date()) {
    await pool.query(
      "UPDATE email_queue_state SET paused_until = NULL, pause_reason = NULL WHERE singleton = TRUE"
    );
    return null;
  }
  return state;
}

export async function getEmailQueueDeliveryStatus(id) {
  const { rows } = await pool.query(
    `SELECT q.status, q.available_at, s.paused_until, s.pause_reason
     FROM email_queue q CROSS JOIN email_queue_state s
     WHERE q.id = $1 AND s.singleton = TRUE`,
    [id]
  );
  const state = rows[0];
  if (!state) return null;
  if (["sent", "failed", "skipped"].includes(state.status)) {
    return { status: state.status };
  }
  if (state.paused_until && new Date(state.paused_until) > new Date()) {
    return { status: "paused", reason: state.pause_reason };
  }
  if (state.status === "pending" && new Date(state.available_at) > new Date()) {
    return { status: "queued" };
  }
  return { status: state.status };
}

export async function waitForEmailQueueDelivery(id, timeoutMs = 16_000) {
  const deadline = Date.now() + timeoutMs;
  let status;
  do {
    status = await getEmailQueueDeliveryStatus(id);
    if (!status || ["sent", "failed", "skipped", "paused", "queued"].includes(status.status)) {
      return status;
    }
    if (Date.now() >= deadline) return status;
    await new Promise((resolve) => setTimeout(resolve, 150));
  } while (Date.now() < deadline);
  return status;
}

export async function pauseEmailQueue(until, reason) {
  await pool.query(
    `UPDATE email_queue_state
     SET paused_until = GREATEST(COALESCE(paused_until, $1), $1), pause_reason = $2
     WHERE singleton = TRUE`,
    [until, reason]
  );
}

export async function claimNextEmail() {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(
      `UPDATE email_queue SET status = 'pending', locked_at = NULL
       WHERE status = 'processing' AND locked_at < CURRENT_TIMESTAMP - INTERVAL '1 minute'`
    );
    const { rows } = await client.query(
      `SELECT id, email, kind, attempts, invitation_id
       FROM email_queue
       WHERE status = 'pending' AND available_at <= CURRENT_TIMESTAMP
       ORDER BY CASE WHEN kind = 'password_reset' THEN 0 ELSE 1 END, created_at, id
       FOR UPDATE SKIP LOCKED
       LIMIT 1`
    );
    if (rows.length === 0) {
      await client.query("COMMIT");
      return null;
    }
    await client.query(
      "UPDATE email_queue SET status = 'processing', locked_at = CURRENT_TIMESTAMP WHERE id = $1",
      [rows[0].id]
    );
    await client.query("COMMIT");
    return rows[0];
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

export async function completeEmailQueueItem(id, status = "sent") {
  await pool.query(
    `UPDATE email_queue
     SET status = $2, sent_at = CASE WHEN $2 = 'sent' THEN CURRENT_TIMESTAMP ELSE sent_at END,
         locked_at = NULL, last_error = NULL
     WHERE id = $1`,
    [id, status]
  );
}

export async function retryEmailQueueItem(id, delayMs, error, { incrementAttempts = true } = {}) {
  await pool.query(
    `UPDATE email_queue
     SET status = 'pending', attempts = attempts + $2,
         available_at = CURRENT_TIMESTAMP + ($3::double precision * INTERVAL '1 millisecond'),
         locked_at = NULL, last_error = $4
     WHERE id = $1`,
    [id, incrementAttempts ? 1 : 0, delayMs, String(error).slice(0, 500)]
  );
}

export async function failEmailQueueItem(id, error) {
  await pool.query(
    `UPDATE email_queue
     SET status = 'failed', attempts = attempts + 1, locked_at = NULL, last_error = $2
     WHERE id = $1`,
    [id, String(error).slice(0, 500)]
  );
}

export async function completePasswordReset({ tokenHash, passwordHash, sessionToken, sessionExpiresAt }) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const { rows: tokens } = await client.query(
      `SELECT t.user_id, u.email
       FROM password_reset_tokens t JOIN users u ON u.id = t.user_id
       WHERE t.token_hash = $1 AND t.expires_at > CURRENT_TIMESTAMP`,
      [tokenHash]
    );
    if (tokens.length === 0) {
      await client.query("ROLLBACK");
      return null;
    }

    await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [tokens[0].email]);
    const { rows: validTokens } = await client.query(
      `SELECT user_id FROM password_reset_tokens
       WHERE token_hash = $1 AND expires_at > CURRENT_TIMESTAMP
       FOR UPDATE`,
      [tokenHash]
    );
    if (validTokens.length === 0) {
      await client.query("ROLLBACK");
      return null;
    }

    const userId = validTokens[0].user_id;
    const { rows } = await client.query(
      `UPDATE users SET password_hash = $1
       WHERE id = $2
       RETURNING id, display_name, email`,
      [passwordHash, userId]
    );
    await client.query("DELETE FROM user_sessions WHERE user_id = $1", [userId]);
    await client.query(
      "INSERT INTO user_sessions (token_hash, user_id, expires_at) VALUES ($1, $2, $3)",
      [digestSessionToken(sessionToken), userId, sessionExpiresAt]
    );
    await client.query("DELETE FROM password_reset_tokens WHERE user_id = $1", [userId]);
    await client.query("COMMIT");
    return toUser(rows[0]);
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

export async function completeRegistration({ tokenHash, displayName, passwordHash, sessionToken, sessionExpiresAt }) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const { rows: tokens } = await client.query(
      `SELECT email, invitation_id FROM registration_tokens
       WHERE token_hash = $1 AND expires_at > CURRENT_TIMESTAMP
      `,
      [tokenHash]
    );
    if (tokens.length === 0) {
      await client.query("ROLLBACK");
      return null;
    }

    await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [tokens[0].email]);
    const { rows: validTokens } = await client.query(
      `SELECT email, invitation_id FROM registration_tokens
       WHERE token_hash = $1 AND expires_at > CURRENT_TIMESTAMP
       FOR UPDATE`,
      [tokenHash]
    );
    if (validTokens.length === 0) {
      await client.query("ROLLBACK");
      return null;
    }

    const { rows } = await client.query(
      `INSERT INTO users (display_name, email, password_hash)
       VALUES ($1, $2, $3)
       RETURNING id, display_name, email`,
      [displayName, validTokens[0].email, passwordHash]
    );
    await client.query(
      "INSERT INTO user_sessions (token_hash, user_id, expires_at) VALUES ($1, $2, $3)",
      [digestSessionToken(sessionToken), rows[0].id, sessionExpiresAt]
    );
    await client.query("DELETE FROM registration_tokens WHERE email = $1", [validTokens[0].email]);
    await client.query(
      `INSERT INTO notifications (recipient_id, actor_id, type, tribe_id, invitation_id)
       SELECT $1, i.inviter_id, 'tribe_invitation', i.tribe_id, i.id
       FROM tribe_invitations i
       WHERE i.email = $2 AND i.status = 'pending' AND i.expires_at > CURRENT_TIMESTAMP AND i.inviter_id <> $1
       ON CONFLICT (invitation_id) WHERE invitation_id IS NOT NULL DO NOTHING`,
      [rows[0].id, validTokens[0].email]
    );
    const invitation = validTokens[0].invitation_id ? await client.query(
      "SELECT tribe_id FROM tribe_invitations WHERE id = $1 AND email = $2 AND status = 'pending' AND expires_at > CURRENT_TIMESTAMP",
      [validTokens[0].invitation_id, validTokens[0].email]) : { rows: [] };
    await client.query("COMMIT");
    return { ...toUser(rows[0]), invitationTribeId: invitation.rows[0]?.tribe_id ?? null };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

export async function getUserByEmail(email) {
  const { rows } = await pool.query(
    "SELECT id, display_name, email, password_hash FROM users WHERE email = $1",
    [email]
  );
  return rows[0] ?? null;
}

export async function getUserPasswordHash(userId) {
  const { rows } = await pool.query("SELECT password_hash FROM users WHERE id = $1", [userId]);
  return rows[0]?.password_hash ?? null;
}

export async function changeUserPassword(userId, currentPasswordHash, nextPasswordHash, currentToken) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const { rowCount } = await client.query(
      "UPDATE users SET password_hash = $3 WHERE id = $1 AND password_hash = $2",
      [userId, currentPasswordHash, nextPasswordHash]
    );
    if (!rowCount) {
      await client.query("ROLLBACK");
      return false;
    }
    await client.query(
      "DELETE FROM user_sessions WHERE user_id = $1 AND token_hash <> $2",
      [userId, digestSessionToken(currentToken)]
    );
    await client.query("DELETE FROM password_reset_tokens WHERE user_id = $1", [userId]);
    await client.query("COMMIT");
    return true;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

export async function createSession(userId, token, expiresAt) {
  await pool.query(
    "INSERT INTO user_sessions (token_hash, user_id, expires_at) VALUES ($1, $2, $3)",
    [digestSessionToken(token), userId, expiresAt]
  );
}

export async function getSessionUser(token) {
  if (!token) return null;
  const { rows } = await pool.query(
    `SELECT u.id, u.display_name, u.email, u.about_me, u.city, u.interests, u.profile_visibility,
            EXISTS (SELECT 1 FROM user_profile_images i WHERE i.user_id = u.id AND i.is_deleted = FALSE) AS has_avatar
     FROM user_sessions s
     JOIN users u ON u.id = s.user_id
     WHERE s.token_hash = $1 AND s.expires_at > CURRENT_TIMESTAMP
       AND s.created_at + ($2 * INTERVAL '1 second') > CURRENT_TIMESTAMP`,
    [digestSessionToken(token), SESSION_MAX_AGE_SECONDS]
  );
  if (!rows[0]) return null;
  try {
    await Promise.all([
      pool.query(
        `UPDATE users SET last_seen_at = CURRENT_TIMESTAMP
         WHERE id = $1 AND (last_seen_at IS NULL OR last_seen_at < CURRENT_TIMESTAMP - INTERVAL '5 minutes')`,
        [rows[0].id]
      ),
      pool.query(
        `UPDATE user_sessions SET last_seen_at = CURRENT_TIMESTAMP
         WHERE token_hash = $1 AND last_seen_at < CURRENT_TIMESTAMP - INTERVAL '5 minutes'`,
        [digestSessionToken(token)]
      ),
    ]);
  } catch (error) {
    console.error("Falha ao atualizar atividade da sessão:", error);
  }
  return toUser(rows[0]);
}

export async function renewSession(token, idleTtlSeconds) {
  if (!token) return null;
  const { rows } = await pool.query(
    `UPDATE user_sessions
     SET expires_at = LEAST(
       CURRENT_TIMESTAMP + ($2 * INTERVAL '1 second'),
       created_at + ($3 * INTERVAL '1 second')
     )
     WHERE token_hash = $1
       AND expires_at > CURRENT_TIMESTAMP
       AND created_at + ($3 * INTERVAL '1 second') > CURRENT_TIMESTAMP
       AND expires_at < created_at + ($3 * INTERVAL '1 second')
       AND expires_at < CURRENT_TIMESTAMP + ($4 * INTERVAL '1 second')
     RETURNING GREATEST(1, CEIL(EXTRACT(EPOCH FROM (expires_at - CURRENT_TIMESTAMP))))::int AS ttl_seconds`,
    [digestSessionToken(token), idleTtlSeconds, SESSION_MAX_AGE_SECONDS, SESSION_RENEW_THRESHOLD_SECONDS]
  );
  return rows[0]?.ttl_seconds ?? null;
}

export async function deleteSession(token) {
  if (!token) return;
  await pool.query("DELETE FROM user_sessions WHERE token_hash = $1", [digestSessionToken(token)]);
}

function toUser(row) {
  return {
    id: row.id,
    name: row.display_name,
    email: row.email,
    aboutMe: row.about_me ?? "",
    city: row.city ?? "",
    interests: Array.isArray(row.interests) ? row.interests : [],
    profileVisibility: {
      aboutMe: row.profile_visibility?.aboutMe === "public" ? "public" : "private",
      city: row.profile_visibility?.city === "public" ? "public" : "private",
      interests: row.profile_visibility?.interests === "public" ? "public" : "private",
    },
    avatarUrl: row.has_avatar ? `/api/users/${row.id}/avatar` : null,
  };
}

export async function updateUserProfile(userId, { name, aboutMe, city, interests, profileVisibility, avatar }) {
  const client = await pool.connect();
  let newImageKey = null;
  let oldImageKey = null;
  try {
    await client.query("BEGIN");
    const { rows } = await client.query(
      `UPDATE users SET display_name = $2, about_me = $3, city = $4, interests = $5::jsonb, profile_visibility = COALESCE($6::jsonb, profile_visibility)
       WHERE id = $1
       RETURNING id, display_name, email, about_me, city, interests, profile_visibility`,
      [userId, name, aboutMe, city, JSON.stringify(interests), JSON.stringify(profileVisibility)]
    );
    if (rows.length === 0) {
      await client.query("ROLLBACK");
      return null;
    }

    if (avatar === null) {
      const { rows: existingImages } = await client.query(
        "SELECT image_key, image_data FROM user_profile_images WHERE user_id = $1 FOR UPDATE",
        [userId]
      );
      const existing = existingImages[0];
      if (existing) {
        oldImageKey = existing.image_key;
        if (existing.image_data !== null) {
          await client.query(
            "UPDATE user_profile_images SET image_key = NULL, is_deleted = TRUE WHERE user_id = $1",
            [userId]
          );
        } else {
          await client.query("DELETE FROM user_profile_images WHERE user_id = $1", [userId]);
        }
      }
    } else if (avatar) {
      const { rows: existingImages } = await client.query(
        "SELECT image_key FROM user_profile_images WHERE user_id = $1 FOR UPDATE",
        [userId]
      );
      oldImageKey = existingImages[0]?.image_key ?? null;
      newImageKey = await getObjectStorage().putImage("avatar", avatar, userId);
      await client.query(
        `INSERT INTO user_profile_images (user_id, mime_type, image_data, byte_size, image_key, is_deleted)
         VALUES ($1, $2, NULL, $3, $4, FALSE)
         ON CONFLICT (user_id) DO UPDATE
         SET mime_type = EXCLUDED.mime_type, byte_size = EXCLUDED.byte_size,
             image_key = EXCLUDED.image_key, is_deleted = FALSE`,
        [userId, avatar.mimeType, avatar.data.length, newImageKey]
      );
    }
    const { rows: updated } = await client.query(
      `SELECT u.id, u.display_name, u.email, u.about_me, u.city, u.interests, u.profile_visibility,
              EXISTS (SELECT 1 FROM user_profile_images i WHERE i.user_id = u.id AND i.is_deleted = FALSE) AS has_avatar
       FROM users u WHERE u.id = $1`,
      [userId]
    );
    await client.query("COMMIT");
    if (oldImageKey && oldImageKey !== newImageKey) await removeObjectBestEffort(oldImageKey);
    return toUser(updated[0]);
  } catch (error) {
    await client.query("ROLLBACK");
    if (newImageKey) await removeObjectBestEffort(newImageKey);
    throw error;
  } finally {
    client.release();
  }
}

async function removeObjectBestEffort(imageKey) {
  try {
    await getObjectStorage().deleteObject(imageKey);
  } catch {
    console.warn("Não foi possível remover um objeto R2 substituído ou removido.");
  }
}

export async function getPublicUserProfile(userId, viewerId) {
  const { rows } = await pool.query(
    `SELECT u.id, u.display_name,
            CASE WHEN u.id = $2 OR u.profile_visibility->>'aboutMe' = 'public'
              THEN u.about_me ELSE '' END AS about_me,
            CASE WHEN u.id = $2 OR u.profile_visibility->>'city' = 'public'
              THEN u.city ELSE '' END AS city,
            CASE WHEN u.id = $2 OR u.profile_visibility->>'interests' = 'public'
              THEN u.interests ELSE '[]'::jsonb END AS interests,
            EXISTS (SELECT 1 FROM user_profile_images i WHERE i.user_id = u.id AND i.is_deleted = FALSE) AS has_avatar
     FROM users u WHERE u.id = $1`,
    [userId, viewerId]
  );
  const row = rows[0];
  return row ? {
    id: row.id,
    name: row.display_name,
    aboutMe: row.about_me,
    city: row.city ?? "",
    interests: Array.isArray(row.interests) ? row.interests : [],
    avatarUrl: row.has_avatar ? `/api/users/${row.id}/avatar` : null,
    isMe: userId === viewerId,
  } : null;
}


export async function getUserProfileImage(userId) {
  const { rows } = await pool.query(
    `SELECT mime_type, image_data, image_key
     FROM user_profile_images WHERE user_id = $1 AND is_deleted = FALSE`,
    [userId]
  );
  return rows[0] ? {
    mimeType: rows[0].mime_type,
    data: rows[0].image_data,
    imageKey: rows[0].image_key,
  } : null;
}

export async function searchTribes(userId, { query = "", mine = false, managed = false, limit = 40 }) {
  const { rows } = await pool.query(
    `SELECT t.id, t.name, t.description, t.category, t.format, t.city, t.neighborhood,
            t.created_at, t.is_private, (t.moderator_id = $1) AS is_moderator,
            COUNT(DISTINCT m.user_id)::int AS member_count,
            COALESCE(bool_or(m.user_id = $1 AND m.status = 'active'), false) AS is_member
     FROM tribes t
     LEFT JOIN tribe_memberships m ON m.tribe_id = t.id AND m.status = 'active'
     WHERE ($2::boolean = false OR EXISTS (
       SELECT 1 FROM tribe_memberships mine
       WHERE mine.tribe_id = t.id AND mine.user_id = $1 AND mine.status = 'active'
     ))
       AND ($3 = '' OR t.name ILIKE $4 OR t.description ILIKE $4 OR t.category ILIKE $4
            OR t.city ILIKE $4 OR t.neighborhood ILIKE $4)
       AND ($6::boolean = false OR t.moderator_id = $1)
     GROUP BY t.id
     ORDER BY t.created_at DESC, t.id DESC
     LIMIT $5`,
    [userId, mine, query, `%${query}%`, limit, managed]
  );
  return rows.map((row) => ({
    id: row.id,
    name: row.name,
    description: row.description,
    category: row.category,
    format: row.format,
    city: row.city,
    neighborhood: row.neighborhood,
    createdAt: row.created_at,
    memberCount: row.member_count,
    isMember: row.is_member,
    isModerator: row.is_moderator,
    isPrivate: row.is_private,
  }));
}

export async function listPopularPublicTribes(limit = 3) {
  const { rows } = await pool.query(
    `SELECT t.id, t.name, t.description, t.category, t.format, t.city, t.neighborhood,
            t.created_at, COUNT(DISTINCT m.user_id)::int AS member_count
     FROM tribes t
     LEFT JOIN tribe_memberships m ON m.tribe_id = t.id AND m.status = 'active'
     WHERE t.is_private = FALSE
     GROUP BY t.id
     ORDER BY member_count DESC, t.created_at DESC, t.id DESC
     LIMIT $1`,
    [limit]
  );
  return rows.map((row) => ({
    id: row.id,
    name: row.name,
    description: row.description,
    category: row.category,
    format: row.format,
    city: row.city,
    neighborhood: row.neighborhood,
    createdAt: row.created_at,
    memberCount: row.member_count,
    isMember: false,
    isPrivate: false,
  }));
}

export async function getPublicTribe(tribeId) {
  const { rows } = await pool.query(
    `SELECT t.id, t.name, t.description, t.category, t.format, t.city, t.neighborhood,
            t.created_at, t.is_private, COUNT(DISTINCT m.user_id)::int AS member_count
     FROM tribes t
     LEFT JOIN tribe_memberships m ON m.tribe_id = t.id AND m.status = 'active'
     WHERE t.id = $1
     GROUP BY t.id`,
    [tribeId]
  );
  const row = rows[0];
  if (!row) return null;
  return {
    id: row.id, name: row.name, description: row.description, category: row.category,
    format: row.format, city: row.city, neighborhood: row.neighborhood,
    createdAt: row.created_at, memberCount: row.member_count, isMember: false, isPrivate: row.is_private,
  };
}


export async function createTribe(userId, tribe) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const { rows } = await client.query(
      `INSERT INTO tribes (name, description, category, format, city, neighborhood, created_by, moderator_id, is_private, password_hash)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $7, $8, $9)
       RETURNING id, name, description, category, format, city, neighborhood, created_at`,
      [tribe.name, tribe.description, tribe.category, tribe.format, tribe.city, tribe.neighborhood, userId, tribe.isPrivate, tribe.passwordHash]
    );
    await client.query(
      "INSERT INTO tribe_memberships (tribe_id, user_id) VALUES ($1, $2)",
      [rows[0].id, userId]
    );
    await client.query("COMMIT");
    return { ...rows[0], memberCount: 1, isMember: true, isPrivate: tribe.isPrivate, createdAt: rows[0].created_at };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

export async function updateTribe(userId, tribeId, tribe) {
  const { rows } = await pool.query(
    `UPDATE tribes
     SET name = $3, description = $4, category = $5, format = $6, city = $7, neighborhood = $8
     WHERE id = $1 AND moderator_id = $2
     RETURNING id, name, description, category, format, city, neighborhood, created_at`,
    [tribeId, userId, tribe.name, tribe.description, tribe.category, tribe.format, tribe.city, tribe.neighborhood]
  );
  return rows[0] ?? null;
}

export async function deleteTribe(userId, tribeId, confirmationName) {
  const client = await pool.connect();
  let imageKeys = [];
  try {
    await client.query("BEGIN");
    const { rows: tribes } = await client.query(
      "SELECT name FROM tribes WHERE id = $1 AND moderator_id = $2 FOR UPDATE",
      [tribeId, userId]
    );
    if (!tribes.length) {
      await client.query("ROLLBACK");
      return null;
    }
    if (tribes[0].name !== confirmationName) {
      await client.query("ROLLBACK");
      return false;
    }
    const { rows: images } = await client.query(
      `SELECT i.image_key FROM content_images i
       JOIN feed_items f ON f.id = i.content_id
       WHERE f.tribe_id = $1 AND i.image_key IS NOT NULL`,
      [tribeId]
    );
    imageKeys = images.map((image) => image.image_key);
    await client.query("DELETE FROM tribes WHERE id = $1 AND moderator_id = $2", [tribeId, userId]);
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
  await Promise.all(imageKeys.map(removeObjectBestEffort));
  return true;
}

export async function createTribeInvitation(userId, tribeId, email, tokenHash) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [email]);
    const { rows: tribes } = await client.query("SELECT moderator_id FROM tribes WHERE id = $1 FOR UPDATE", [tribeId]);
    if (!tribes.length || tribes[0].moderator_id !== userId) { await client.query("ROLLBACK"); return "forbidden"; }
    await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [`tribe-inviter:${userId}`]);
    const members = await client.query(
      `SELECT 1 FROM users u JOIN tribe_memberships m ON m.user_id = u.id
       WHERE u.email = $1 AND m.tribe_id = $2 AND m.status = 'active'`, [email, tribeId]);
    if (members.rowCount) { await client.query("ROLLBACK"); return "member"; }
    await client.query(
      "UPDATE tribe_invitations SET status = 'expired', responded_at = CURRENT_TIMESTAMP WHERE tribe_id = $1 AND email = $2 AND status = 'pending' AND expires_at <= CURRENT_TIMESTAMP",
      [tribeId, email]);
    const existing = await client.query("SELECT 1 FROM tribe_invitations WHERE tribe_id = $1 AND email = $2 AND status = 'pending'", [tribeId, email]);
    if (existing.rowCount) { await client.query("ROLLBACK"); return "duplicate"; }
    const count = await client.query("SELECT COUNT(*)::int AS count FROM tribe_invitations WHERE inviter_id = $1 AND created_at > CURRENT_TIMESTAMP - INTERVAL '1 hour'", [userId]);
    if (count.rows[0].count >= 20) { await client.query("ROLLBACK"); return "limited"; }
    const { rows } = await client.query(
      "INSERT INTO tribe_invitations (tribe_id, inviter_id, email, token_hash) VALUES ($1, $2, $3, $4) RETURNING id",
      [tribeId, userId, email, tokenHash]);
    const recipient = await client.query("SELECT id FROM users WHERE email = $1", [email]);
    if (recipient.rowCount) {
      await client.query("INSERT INTO notifications (recipient_id, actor_id, type, tribe_id, invitation_id) VALUES ($1, $2, 'tribe_invitation', $3, $4)", [recipient.rows[0].id, userId, tribeId, rows[0].id]);
    } else {
      await client.query("INSERT INTO email_queue (email, kind, invitation_id) VALUES ($1, 'tribe_invitation', $2)", [email, rows[0].id]);
    }
    await client.query("COMMIT");
    return "created";
  } catch (error) { await client.query("ROLLBACK"); throw error; } finally { client.release(); }
}

export async function prepareInvitationEmail(invitationId, tokenHash) {
  const { rows } = await pool.query(
    `UPDATE tribe_invitations i SET token_hash = $2
     FROM tribes t, users u
     WHERE i.id = $1 AND i.status = 'pending' AND i.expires_at > CURRENT_TIMESTAMP
       AND t.id = i.tribe_id AND u.id = i.inviter_id
     RETURNING i.email, t.name AS tribe_name, u.display_name AS inviter_name`, [invitationId, tokenHash]);
  return rows[0] ?? null;
}

export async function listTribeInvitations(userId, tribeId) {
  const { rows: allowed } = await pool.query("SELECT 1 FROM tribes WHERE id = $1 AND moderator_id = $2", [tribeId, userId]);
  if (!allowed.length) return null;
  const { rows } = await pool.query(
    `SELECT i.id, i.email, i.created_at, i.expires_at FROM tribe_invitations i
     JOIN tribes t ON t.id = i.tribe_id
     WHERE i.tribe_id = $1 AND t.moderator_id = $2 AND i.status = 'pending' AND i.expires_at > CURRENT_TIMESTAMP ORDER BY i.created_at DESC`, [tribeId, userId]);
  return rows.map(row => ({ id: row.id, email: row.email, createdAt: row.created_at, expiresAt: row.expires_at }));
}

export async function listReceivedInvitations(email, tribeId = null) {
  const { rows } = await pool.query(
    `SELECT i.id, i.tribe_id, t.name AS tribe_name, u.display_name AS inviter_name, i.expires_at
     FROM tribe_invitations i JOIN tribes t ON t.id = i.tribe_id JOIN users u ON u.id = i.inviter_id
     WHERE i.email = $1 AND i.status = 'pending' AND i.expires_at > CURRENT_TIMESTAMP
       AND ($2::uuid IS NULL OR i.tribe_id = $2) ORDER BY i.created_at DESC`, [email, tribeId]);
  return rows.map(row => ({ id: row.id, tribeId: row.tribe_id, tribeName: row.tribe_name, inviterName: row.inviter_name, expiresAt: row.expires_at }));
}

export async function resolveInvitation(email, tokenHash) {
  const { rows } = await pool.query(
    `SELECT tribe_id FROM tribe_invitations WHERE email = $1 AND token_hash = $2
       AND status = 'pending' AND expires_at > CURRENT_TIMESTAMP`, [email, tokenHash]);
  return rows[0]?.tribe_id ?? null;
}

export async function invitationForRegistration(email, tokenHash) {
  const { rows } = await pool.query(
    "SELECT id FROM tribe_invitations WHERE email = $1 AND token_hash = $2 AND status = 'pending' AND expires_at > CURRENT_TIMESTAMP", [email, tokenHash]);
  return rows[0]?.id ?? null;
}

export async function respondToInvitation(userId, email, invitationId, action) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const lookup = await client.query("SELECT tribe_id FROM tribe_invitations WHERE id = $1", [invitationId]);
    if (!lookup.rowCount) { await client.query("ROLLBACK"); return false; }
    const tribeId = lookup.rows[0].tribe_id;
    const tribe = await client.query("SELECT moderator_id FROM tribes WHERE id = $1 FOR UPDATE", [tribeId]);
    if (!tribe.rowCount) { await client.query("ROLLBACK"); return false; }
    const invite = await client.query(
      "SELECT email FROM tribe_invitations WHERE id = $1 AND status = 'pending' AND expires_at > clock_timestamp() FOR UPDATE", [invitationId]);
    if (!invite.rowCount || (action === 'cancelled' ? tribe.rows[0].moderator_id !== userId : invite.rows[0].email !== email)) {
      await client.query("ROLLBACK"); return false;
    }
    if (action === 'accepted') {
      await client.query(
        `INSERT INTO tribe_memberships (tribe_id, user_id, status, joined_at, left_at)
         VALUES ($1, $2, 'active', CURRENT_TIMESTAMP, NULL)
         ON CONFLICT (tribe_id, user_id) DO UPDATE SET status = 'active', joined_at = CURRENT_TIMESTAMP, left_at = NULL
         WHERE tribe_memberships.status <> 'active'`, [tribeId, userId]);
    }
    await client.query("UPDATE tribe_invitations SET status = $2, responded_at = CURRENT_TIMESTAMP WHERE id = $1", [invitationId, action]);
    await client.query("COMMIT");
    return true;
  } catch (error) { await client.query("ROLLBACK"); throw error; } finally { client.release(); }
}

export async function joinTribe(userId, tribeId, password) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const { rows } = await client.query("SELECT is_private, password_hash FROM tribes WHERE id = $1 FOR UPDATE", [tribeId]);
    if (!rows.length) { await client.query("ROLLBACK"); return "not_found"; }
    if (rows[0].is_private && (typeof password !== "string" || password.length === 0 || password.length > 128 || !(await verifyPassword(password, rows[0].password_hash)))) {
      await client.query("ROLLBACK");
      return "invalid_password";
    }
    await client.query(
      `INSERT INTO tribe_memberships (tribe_id, user_id, status, joined_at, left_at)
       VALUES ($1, $2, 'active', CURRENT_TIMESTAMP, NULL)
       ON CONFLICT (tribe_id, user_id)
       DO UPDATE SET status = 'active', joined_at = CURRENT_TIMESTAMP, left_at = NULL
       WHERE tribe_memberships.status <> 'active'`,
      [tribeId, userId]
    );
    await client.query("COMMIT");
    return "joined";
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

export async function leaveTribe(userId, tribeId) {
  const client = await pool.connect();
  let imageKeys = [];
  let result = { tribeDeleted: false };
  try {
    await client.query("BEGIN");
    const { rows: tribes } = await client.query(
      "SELECT moderator_id FROM tribes WHERE id = $1 FOR UPDATE",
      [tribeId]
    );
    if (!tribes.length) {
      await client.query("ROLLBACK");
      return result;
    }

    const { rows: memberships } = await client.query(
      `SELECT status FROM tribe_memberships
       WHERE tribe_id = $1 AND user_id = $2 FOR UPDATE`,
      [tribeId, userId]
    );
    if (memberships[0]?.status !== "active") {
      await client.query("ROLLBACK");
      return result;
    }

    if (tribes[0].moderator_id === userId) {
      const { rows: successors } = await client.query(
        `SELECT user_id FROM tribe_memberships
         WHERE tribe_id = $1 AND status = 'active' AND user_id <> $2
         ORDER BY joined_at ASC, user_id ASC
         LIMIT 1`,
        [tribeId, userId]
      );

      if (successors.length === 0) {
        await client.query(
          `SELECT user_id FROM tribe_memberships
           WHERE tribe_id = $1 AND status = 'active' FOR UPDATE`,
          [tribeId]
        );
        const { rows: images } = await client.query(
          `SELECT i.image_key FROM content_images i
           JOIN feed_items f ON f.id = i.content_id
           WHERE f.tribe_id = $1 AND i.image_key IS NOT NULL`,
          [tribeId]
        );
        imageKeys = images.map((image) => image.image_key);
        await client.query("DELETE FROM tribes WHERE id = $1", [tribeId]);
        result = { tribeDeleted: true };
      } else {
        await client.query(
          "UPDATE tribes SET moderator_id = $2 WHERE id = $1",
          [tribeId, successors[0].user_id]
        );
        await client.query(
          `UPDATE tribe_memberships SET status = 'left', left_at = CURRENT_TIMESTAMP
           WHERE tribe_id = $1 AND user_id = $2 AND status = 'active'`,
          [tribeId, userId]
        );
        result = { tribeDeleted: false, moderatorId: successors[0].user_id };
      }
    } else {
      await client.query(
        `UPDATE tribe_memberships SET status = 'left', left_at = CURRENT_TIMESTAMP
         WHERE tribe_id = $1 AND user_id = $2 AND status = 'active'`,
        [tribeId, userId]
      );
    }
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
  await Promise.all(imageKeys.map(removeObjectBestEffort));
  return result;
}

export async function userBelongsToTribe(userId, tribeId) {
  const { rowCount } = await pool.query(
    `SELECT 1 FROM tribe_memberships
     WHERE user_id = $1 AND tribe_id = $2 AND status = 'active'`,
    [userId, tribeId]
  );
  return rowCount > 0;
}

export async function getFeed(userId, { tribeId, query, cursor, limit, savedOnly = false, type = "all", contentId }) {
  if (tribeId && !(await userBelongsToTribe(userId, tribeId))) {
    const error = new Error("Você não participa desta tribo.");
    error.statusCode = 403;
    throw error;
  }
  const { rows } = await pool.query(
    `SELECT f.id, f.kind, f.body, f.created_at, f.edited_at,
            author.id AS author_id, author.display_name AS author_name,
            (f.author_id = $1) AS is_mine,
            EXISTS (SELECT 1 FROM user_profile_images i WHERE i.user_id = author.id AND i.is_deleted = FALSE) AS author_has_avatar,
            t.id AS tribe_id, t.name AS tribe_name,
            e.title AS event_title, e.starts_at, e.ends_at, e.location, e.location_lat, e.location_lon, e.cost, e.max_attendees,
            CASE WHEN f.kind = 'poll' THEN (
              SELECT json_build_object(
                'options', COALESCE((SELECT json_agg(json_build_object(
                  'id', po.id, 'label', po.label, 'votes', po.vote_count
                ) ORDER BY po.position) FROM (
                  SELECT o.id, o.label, o.position, COUNT(v.user_id)::int AS vote_count
                  FROM poll_options o LEFT JOIN poll_votes v ON v.option_id = o.id
                  WHERE o.content_id = f.id GROUP BY o.id
                ) po), '[]'::json),
                'multiple', f.poll_multiple,
                'totalVotes', (SELECT COUNT(DISTINCT v.user_id)::int FROM poll_votes v WHERE v.content_id = f.id),
                'votedOptionIds', COALESCE((SELECT json_agg(v.option_id) FROM poll_votes v WHERE v.content_id = f.id AND v.user_id = $1), '[]'::json)
              )
            ) ELSE NULL END AS poll_data,
            EXISTS (SELECT 1 FROM content_images i WHERE i.content_id = f.id) AS has_image,
            (SELECT COUNT(*) FROM content_likes l WHERE l.content_id = f.id)::int AS like_count,
            (SELECT COUNT(*) FROM content_comments c WHERE c.content_id = f.id)::int AS comment_count,
            EXISTS (SELECT 1 FROM content_likes l WHERE l.content_id = f.id AND l.user_id = $1) AS liked_by_me,
            EXISTS (SELECT 1 FROM saved_content s WHERE s.content_id = f.id AND s.user_id = $1) AS saved_by_me,
            (SELECT COUNT(*) FROM event_attendees a WHERE a.content_id = f.id)::int AS attendee_count,
            EXISTS (SELECT 1 FROM event_attendees a WHERE a.content_id = f.id AND a.user_id = $1) AS attending_by_me,
            (SELECT COUNT(*) FROM event_waitlist w WHERE w.content_id = f.id)::int AS waitlist_count,
            EXISTS (SELECT 1 FROM event_waitlist w WHERE w.content_id = f.id AND w.user_id = $1) AS waitlisted_by_me
     FROM feed_items f
     JOIN tribe_memberships m ON m.tribe_id = f.tribe_id AND m.user_id = $1 AND m.status = 'active'
     JOIN users author ON author.id = f.author_id
     JOIN tribes t ON t.id = f.tribe_id
     LEFT JOIN tribe_events e ON e.content_id = f.id
      WHERE ($2::uuid IS NULL OR f.tribe_id = $2)
        AND ($9::uuid IS NULL OR f.id = $9)
        AND ($3::text IS NULL OR (f.body ILIKE $3 OR author.display_name ILIKE $3 OR t.name ILIKE $3 OR e.title ILIKE $3 OR e.location ILIKE $3))
       AND ($4::timestamptz IS NULL OR (f.created_at, f.id) < ($4, $5::uuid))
       AND ($7::boolean = false OR EXISTS (SELECT 1 FROM saved_content s WHERE s.content_id = f.id AND s.user_id = $1))
       AND ($8::text = 'all' OR f.kind = $8)
     ORDER BY f.created_at DESC, f.id DESC
     LIMIT $6`,
    [userId, tribeId ?? null, query ? `%${query}%` : null, cursor?.createdAt ?? null, cursor?.id ?? null, limit + 1, savedOnly, type, contentId ?? null]
  );
  const hasMore = rows.length > limit;
  const pageRows = rows.slice(0, limit);
  const items = pageRows.map((row) => ({
    id: row.id,
    type: row.kind,
    body: row.body,
    imageUrl: row.has_image ? `/api/content/${row.id}/image` : null,
    createdAt: row.created_at,
    editedAt: row.edited_at,
    isMine: row.is_mine,
    author: {
      id: row.author_id,
      name: row.author_name,
      avatarUrl: row.author_has_avatar ? `/api/users/${row.author_id}/avatar` : null,
    },
    tribe: { id: row.tribe_id, name: row.tribe_name },
    likesCount: row.like_count,
    commentsCount: row.comment_count,
    likedByMe: row.liked_by_me,
    savedByMe: row.saved_by_me,
    poll: row.kind === "poll" ? row.poll_data : null,
    event: row.kind === "event" ? {
      title: row.event_title,
      startsAt: row.starts_at,
      endsAt: row.ends_at,
      location: row.location,
      lat: row.location_lat,
      lon: row.location_lon,
      cost: row.cost,
      maxAttendees: row.max_attendees,
      attendeesCount: row.attendee_count,
      attendingByMe: row.attending_by_me,
      waitlistCount: row.waitlist_count,
      waitlistedByMe: row.waitlisted_by_me,
    } : null,
  }));
  const last = pageRows.at(-1);
  return {
    items,
    nextCursor: hasMore && last ? encodeCursor({ createdAt: last.created_at, id: last.id }) : null,
  };
}

export async function getContentItem(userId, contentId) {
  const { items } = await getFeed(userId, { contentId, limit: 1 });
  return items[0] ?? null;
}

function encodeCursor(cursor) {
  return Buffer.from(JSON.stringify(cursor)).toString("base64url");
}

export function decodeCursor(value) {
  if (!value) return null;
  try {
    const parsed = JSON.parse(Buffer.from(value, "base64url").toString("utf8"));
    if (!parsed || typeof parsed.createdAt !== "string" || !Number.isFinite(Date.parse(parsed.createdAt)) ||
      !/^\d{4}-\d\d-\d\dT/.test(parsed.createdAt) ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(parsed.id)) {
      throw new Error();
    }
    return { createdAt: parsed.createdAt, id: parsed.id };
  } catch {
    const error = new Error("Cursor de paginação inválido.");
    error.statusCode = 400;
    throw error;
  }
}

export async function createContent(userId, tribeId, { type, body, event, image, pollOptions, pollMultiple = false }) {
  const client = await pool.connect();
  let imageKey = null;
  try {
    await client.query("BEGIN");
    const { rows: membership } = await client.query(
      `SELECT 1 FROM tribe_memberships
       WHERE user_id = $1 AND tribe_id = $2 AND status = 'active' FOR SHARE`,
      [userId, tribeId]
    );
    if (membership.length === 0) {
      const error = new Error("Você não participa desta tribo.");
      error.statusCode = 403;
      throw error;
    }
    const { rows } = await client.query(
      `INSERT INTO feed_items (tribe_id, author_id, kind, body, poll_multiple)
       VALUES ($1, $2, $3, $4, $5) RETURNING id, created_at`,
      [tribeId, userId, type, body, type === "poll" && pollMultiple]
    );
    if (image) {
      imageKey = await getObjectStorage().putImage("content", image);
      await client.query(
        `INSERT INTO content_images (content_id, mime_type, image_data, byte_size, image_key)
         VALUES ($1, $2, NULL, $3, $4)`,
        [rows[0].id, image.mimeType, image.data.length, imageKey]
      );
    }
    if (type === "poll") {
      for (let index = 0; index < pollOptions.length; index += 1) {
        await client.query(
          "INSERT INTO poll_options (content_id, position, label) VALUES ($1, $2, $3)",
          [rows[0].id, index, pollOptions[index]]
        );
      }
    }
    if (type === "event") {
      await client.query(
        `INSERT INTO tribe_events (content_id, title, starts_at, ends_at, location, location_lat, location_lon, cost, max_attendees)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
        [rows[0].id, event.title, event.startsAt, event.endsAt, event.location, event.lat, event.lon, event.cost, event.maxAttendees]
      );
      await client.query(
        `INSERT INTO notifications (recipient_id, actor_id, type, content_id, tribe_id)
         SELECT m.user_id, $2, 'event_created', $1, $3
         FROM tribe_memberships m
         WHERE m.tribe_id = $3 AND m.status = 'active' AND m.user_id <> $2`,
        [rows[0].id, userId, tribeId]
      );
    }
    await client.query("COMMIT");
    imageKey = null;
    return rows[0];
  } catch (error) {
    await client.query("ROLLBACK");
    if (imageKey) await removeObjectBestEffort(imageKey);
    throw error;
  } finally {
    client.release();
  }
}

export async function updateContent(userId, contentId, body, event) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const { rows } = await client.query(
      `UPDATE feed_items f SET body = $3, edited_at = CURRENT_TIMESTAMP
       FROM tribe_memberships m
       WHERE f.id = $1 AND f.author_id = $2
         AND m.tribe_id = f.tribe_id AND m.user_id = $2 AND m.status = 'active'
       RETURNING f.id, f.kind, f.body, f.edited_at`,
      [contentId, userId, body]
    );
    if (!rows.length) {
      await client.query("ROLLBACK");
      return null;
    }
    if (event && rows[0].kind === "event") {
      const { rows: attendance } = await client.query(
        "SELECT COUNT(*)::int AS count FROM event_attendees WHERE content_id = $1",
        [contentId]
      );
      if (event.maxAttendees !== null && attendance[0].count > event.maxAttendees) {
        const error = new Error("O limite não pode ser menor que o número de presenças confirmadas.");
        error.statusCode = 400;
        throw error;
      }
      await client.query(
        `UPDATE tribe_events
         SET title = $2, starts_at = $3, ends_at = $4, location = $5, location_lat = $6, location_lon = $7, cost = $8, max_attendees = $9
         WHERE content_id = $1`,
        [contentId, event.title, event.startsAt, event.endsAt, event.location, event.lat, event.lon, event.cost, event.maxAttendees]
      );
      let currentCount = attendance[0].count;
      while (event.maxAttendees === null || currentCount < event.maxAttendees) {
        const { rows: next } = await client.query(
          `SELECT user_id FROM event_waitlist WHERE content_id = $1
           ORDER BY created_at ASC, user_id ASC LIMIT 1 FOR UPDATE`,
          [contentId]
        );
        if (!next.length) break;
        await client.query("DELETE FROM event_waitlist WHERE content_id = $1 AND user_id = $2", [contentId, next[0].user_id]);
        await client.query("INSERT INTO event_attendees (content_id, user_id) VALUES ($1, $2) ON CONFLICT DO NOTHING", [contentId, next[0].user_id]);
        currentCount += 1;
      }
    }
    await client.query("COMMIT");
    return rows[0];
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

export async function deleteContent(userId, contentId) {
  const client = await pool.connect();
  let imageKey = null;
  try {
    await client.query("BEGIN");
    const { rows: images } = await client.query(
      `SELECT i.image_key FROM feed_items f
       LEFT JOIN content_images i ON i.content_id = f.id
       JOIN tribe_memberships m ON m.tribe_id = f.tribe_id AND m.user_id = $2 AND m.status = 'active'
       WHERE f.id = $1 AND f.author_id = $2 FOR UPDATE OF f`,
      [contentId, userId]
    );
    if (!images.length) {
      await client.query("ROLLBACK");
      return false;
    }
    imageKey = images[0].image_key;
    const removed = await client.query("DELETE FROM feed_items WHERE id = $1 AND author_id = $2 RETURNING id", [contentId, userId]);
    await client.query("COMMIT");
    if (imageKey) await removeObjectBestEffort(imageKey);
    return removed.rowCount > 0;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

export async function getContentImage(userId, contentId) {
  const { rows } = await pool.query(
    `SELECT i.mime_type, i.image_data, i.image_key
     FROM content_images i
     JOIN feed_items f ON f.id = i.content_id
     JOIN tribe_memberships m ON m.tribe_id = f.tribe_id AND m.user_id = $1 AND m.status = 'active'
     WHERE i.content_id = $2`,
    [userId, contentId]
  );
  return rows[0] ? {
    mimeType: rows[0].mime_type,
    data: rows[0].image_data,
    imageKey: rows[0].image_key,
  } : null;
}

export async function setPollVote(userId, contentId, optionId) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const { rows: access } = await client.query(
      `SELECT f.id, f.poll_multiple FROM feed_items f
       JOIN tribe_memberships m ON m.tribe_id = f.tribe_id AND m.user_id = $1 AND m.status = 'active'
       WHERE f.id = $2 AND f.kind = 'poll' FOR UPDATE OF f`,
      [userId, contentId]
    );
    if (!access.length) {
      await client.query("ROLLBACK");
      return null;
    }
    const { rowCount: validOption } = await client.query(
      "SELECT 1 FROM poll_options WHERE id = $1 AND content_id = $2",
      [optionId, contentId]
    );
    if (!validOption) {
      await client.query("ROLLBACK");
      return { invalidOption: true };
    }
    if (access[0].poll_multiple) {
      // Múltipla escolha: votar de novo na mesma opção remove o voto.
      const removed = await client.query(
        "DELETE FROM poll_votes WHERE option_id = $1 AND user_id = $2",
        [optionId, userId]
      );
      if (removed.rowCount === 0) {
        await client.query(
          "INSERT INTO poll_votes (content_id, option_id, user_id) VALUES ($1, $2, $3)",
          [contentId, optionId, userId]
        );
      }
    } else {
      // Escolha única: troca o voto anterior pela nova opção.
      await client.query("DELETE FROM poll_votes WHERE content_id = $1 AND user_id = $2", [contentId, userId]);
      await client.query(
        "INSERT INTO poll_votes (content_id, option_id, user_id) VALUES ($1, $2, $3)",
        [contentId, optionId, userId]
      );
    }
    const { rows: counts } = await client.query(
      `SELECT o.id, COUNT(v.user_id)::int AS votes
       FROM poll_options o LEFT JOIN poll_votes v ON v.option_id = o.id
       WHERE o.content_id = $1 GROUP BY o.id, o.position ORDER BY o.position`,
      [contentId]
    );
    const { rows: totals } = await client.query(
      `SELECT COUNT(DISTINCT user_id)::int AS total,
              COALESCE(array_agg(option_id) FILTER (WHERE user_id = $2), '{}') AS voted_option_ids
       FROM poll_votes WHERE content_id = $1`,
      [contentId, userId]
    );
    await client.query("COMMIT");
    return {
      totalVotes: totals[0].total,
      votedOptionIds: totals[0].voted_option_ids,
      options: counts.map((row) => ({ id: row.id, votes: row.votes })),
    };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

export async function canAccessContent(userId, contentId) {
  const { rowCount } = await pool.query(
    `SELECT 1 FROM feed_items f
     JOIN tribe_memberships m ON m.tribe_id = f.tribe_id AND m.user_id = $1 AND m.status = 'active'
     WHERE f.id = $2`,
    [userId, contentId]
  );
  return rowCount > 0;
}

export async function toggleLike(userId, contentId, liked) {
  if (!(await canAccessContent(userId, contentId))) return null;
  if (liked) {
    const inserted = await pool.query(
      "INSERT INTO content_likes (content_id, user_id) VALUES ($1, $2) ON CONFLICT DO NOTHING RETURNING content_id",
      [contentId, userId]
    );
    if (inserted.rowCount > 0) {
      await pool.query(
        `INSERT INTO notifications (recipient_id, actor_id, type, content_id, tribe_id)
         SELECT f.author_id, $2, 'post_like', f.id, f.tribe_id
         FROM feed_items f WHERE f.id = $1 AND f.author_id <> $2`,
        [contentId, userId]
      );
    }
  } else {
    await pool.query("DELETE FROM content_likes WHERE content_id = $1 AND user_id = $2", [contentId, userId]);
  }
  const { rows } = await pool.query(
    `SELECT COUNT(*)::int AS count,
            EXISTS (SELECT 1 FROM content_likes WHERE content_id = $1 AND user_id = $2) AS liked
     FROM content_likes WHERE content_id = $1`,
    [contentId, userId]
  );
  return { likesCount: rows[0].count, likedByMe: rows[0].liked };
}

export async function setEventAttendance(userId, contentId, attending) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const { rows: eventRows } = await client.query(
      `SELECT e.max_attendees, f.tribe_id FROM feed_items f
       JOIN tribe_events e ON e.content_id = f.id
       JOIN tribe_memberships m ON m.tribe_id = f.tribe_id AND m.user_id = $1 AND m.status = 'active'
       WHERE f.id = $2 FOR UPDATE OF f`,
      [userId, contentId]
    );
    if (!eventRows.length) {
      await client.query("ROLLBACK");
      return null;
    }

    if (attending) {
      const { rowCount: alreadyAttending } = await client.query(
        "SELECT 1 FROM event_attendees WHERE content_id = $1 AND user_id = $2",
        [contentId, userId]
      );
      if (!alreadyAttending) {
        await client.query("DELETE FROM event_waitlist WHERE content_id = $1 AND user_id = $2", [contentId, userId]);
        const { rows: countRows } = await client.query(
          "SELECT COUNT(*)::int AS count FROM event_attendees WHERE content_id = $1",
          [contentId]
        );
        const capacity = eventRows[0].max_attendees;
        if (capacity !== null && countRows[0].count >= capacity) {
          await client.query(
            "INSERT INTO event_waitlist (content_id, user_id) VALUES ($1, $2) ON CONFLICT DO NOTHING",
            [contentId, userId]
          );
        } else {
          await client.query("INSERT INTO event_attendees (content_id, user_id) VALUES ($1, $2) ON CONFLICT DO NOTHING", [contentId, userId]);
          await client.query(
            `INSERT INTO notifications (recipient_id, actor_id, type, content_id, tribe_id)
             SELECT f.author_id, $2, 'event_attendance', f.id, f.tribe_id
             FROM feed_items f WHERE f.id = $1 AND f.author_id <> $2`,
            [contentId, userId]
          );
        }
      }
    } else {
      const removed = await client.query("DELETE FROM event_attendees WHERE content_id = $1 AND user_id = $2 RETURNING user_id", [contentId, userId]);
      await client.query("DELETE FROM event_waitlist WHERE content_id = $1 AND user_id = $2", [contentId, userId]);
      if (removed.rowCount > 0) {
        const { rows: next } = await client.query(
          `SELECT user_id FROM event_waitlist WHERE content_id = $1
           ORDER BY created_at ASC, user_id ASC LIMIT 1 FOR UPDATE`,
          [contentId]
        );
        if (next.length) {
          await client.query("DELETE FROM event_waitlist WHERE content_id = $1 AND user_id = $2", [contentId, next[0].user_id]);
          await client.query("INSERT INTO event_attendees (content_id, user_id) VALUES ($1, $2) ON CONFLICT DO NOTHING", [contentId, next[0].user_id]);
        }
      }
    }

    const { rows } = await client.query(
      `SELECT COUNT(*)::int AS count,
              EXISTS (SELECT 1 FROM event_attendees WHERE content_id = $1 AND user_id = $2) AS attending,
              EXISTS (SELECT 1 FROM event_waitlist WHERE content_id = $1 AND user_id = $2) AS waitlisted,
              (SELECT COUNT(*)::int FROM event_waitlist WHERE content_id = $1) AS waitlist_count
       FROM event_attendees WHERE content_id = $1`,
      [contentId, userId]
    );
    await client.query("COMMIT");
    return {
      attendeesCount: rows[0].count,
      attendingByMe: rows[0].attending,
      waitlistedByMe: rows[0].waitlisted,
      waitlistCount: rows[0].waitlist_count,
    };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

export async function listComments(userId, contentId) {
  if (!(await canAccessContent(userId, contentId))) return null;
  const { rows } = await pool.query(
    `SELECT c.id, c.body, c.created_at, c.edited_at,
            (SELECT COUNT(*)::int FROM comment_likes l WHERE l.comment_id = c.id) AS likes_count,
            EXISTS (SELECT 1 FROM comment_likes l WHERE l.comment_id = c.id AND l.user_id = $2) AS liked_by_me,
            u.id AS author_id, u.display_name AS author_name,
            EXISTS (SELECT 1 FROM user_profile_images i WHERE i.user_id = u.id AND i.is_deleted = FALSE) AS author_has_avatar,
            (c.user_id = $2) AS is_mine
     FROM content_comments c JOIN users u ON u.id = c.user_id
     WHERE c.content_id = $1 ORDER BY likes_count DESC, c.created_at ASC, c.id ASC LIMIT 200`,
    [contentId, userId]
  );
  return rows.map((row) => ({
    id: row.id,
    body: row.body,
    createdAt: row.created_at,
    editedAt: row.edited_at,
    likesCount: row.likes_count,
    likedByMe: row.liked_by_me,
    isMine: row.is_mine,
    author: {
      id: row.author_id,
      name: row.author_name,
      avatarUrl: row.author_has_avatar ? `/api/users/${row.author_id}/avatar` : null,
    },
  }));
}

export async function toggleCommentLike(userId, commentId, liked) {
  if (liked) {
    await pool.query(
      `INSERT INTO comment_likes (comment_id, user_id)
       SELECT c.id, $2
       FROM content_comments c
       JOIN feed_items f ON f.id = c.content_id
       JOIN tribe_memberships m ON m.tribe_id = f.tribe_id AND m.user_id = $2 AND m.status = 'active'
       WHERE c.id = $1
       ON CONFLICT DO NOTHING`,
      [commentId, userId]
    );
  } else {
    await pool.query(
      `DELETE FROM comment_likes l USING content_comments c, feed_items f, tribe_memberships m
       WHERE l.comment_id = c.id AND c.id = $1 AND l.user_id = $2
         AND f.id = c.content_id AND m.tribe_id = f.tribe_id
         AND m.user_id = $2 AND m.status = 'active'`,
      [commentId, userId]
    );
  }

  const { rows } = await pool.query(
    `SELECT (SELECT COUNT(*)::int FROM comment_likes l WHERE l.comment_id = c.id) AS likes_count,
            EXISTS (SELECT 1 FROM comment_likes l WHERE l.comment_id = c.id AND l.user_id = $2) AS liked_by_me
     FROM content_comments c
     JOIN feed_items f ON f.id = c.content_id
     JOIN tribe_memberships m ON m.tribe_id = f.tribe_id AND m.user_id = $2 AND m.status = 'active'
     WHERE c.id = $1`,
    [commentId, userId]
  );
  if (!rows.length) return null;
  return { likesCount: rows[0].likes_count, likedByMe: rows[0].liked_by_me };
}

export async function addComment(userId, contentId, body) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const { rowCount } = await client.query(
      `SELECT 1 FROM feed_items f
       JOIN tribe_memberships m ON m.tribe_id = f.tribe_id AND m.user_id = $1 AND m.status = 'active'
       WHERE f.id = $2 FOR SHARE OF f`,
      [userId, contentId]
    );
    if (!rowCount) {
      await client.query("ROLLBACK");
      return null;
    }
    const { rows } = await client.query(
      `INSERT INTO content_comments (content_id, user_id, body)
       VALUES ($1, $2, $3)
       RETURNING id, body, created_at`,
      [contentId, userId, body]
    );
    await client.query(
      `INSERT INTO notifications (recipient_id, actor_id, type, content_id, tribe_id)
       SELECT f.author_id, $2, 'post_comment', f.id, f.tribe_id
       FROM feed_items f WHERE f.id = $1 AND f.author_id <> $2`,
      [contentId, userId]
    );
    await client.query("COMMIT");
    return { ...rows[0], createdAt: rows[0].created_at, author: null };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

export async function editComment(userId, commentId, body, remove = false) {
  const { rows } = await pool.query(
    remove
      ? `DELETE FROM content_comments c USING feed_items f, tribe_memberships m
         WHERE c.id = $1 AND c.user_id = $2 AND f.id = c.content_id
           AND m.tribe_id = f.tribe_id AND m.user_id = $2 AND m.status = 'active'
         RETURNING c.id`
      : `UPDATE content_comments c SET body = $3, edited_at = CURRENT_TIMESTAMP
         FROM feed_items f, tribe_memberships m
         WHERE c.id = $1 AND c.user_id = $2 AND f.id = c.content_id
           AND m.tribe_id = f.tribe_id AND m.user_id = $2 AND m.status = 'active'
         RETURNING c.id, c.body, c.created_at, c.edited_at`,
    remove ? [commentId, userId] : [commentId, userId, body]
  );
  return rows[0] ?? null;
}

export async function checkDatabase() {
  await pool.query("SELECT 1");
}


export async function listNotifications(userId, limit = 40) {
  const { rows } = await pool.query(
    `SELECT n.id, n.type, n.content_id, n.tribe_id, n.created_at, n.read_at,
            actor.id AS actor_id, actor.display_name AS actor_name,
            t.name AS tribe_name
     FROM notifications n
     JOIN users actor ON actor.id = n.actor_id
     LEFT JOIN tribes t ON t.id = n.tribe_id
     WHERE n.recipient_id = $1
     ORDER BY n.created_at DESC, n.id DESC
     LIMIT $2`,
    [userId, limit]
  );
  const { rows: counts } = await pool.query(
    "SELECT COUNT(*)::int AS unread_count FROM notifications WHERE recipient_id = $1 AND read_at IS NULL",
    [userId]
  );
  return {
    unreadCount: counts[0].unread_count,
    items: rows.map((row) => ({
      id: row.id,
      type: row.type,
      contentId: row.content_id,
      tribeId: row.tribe_id,
      tribeName: row.tribe_name ?? null,
      createdAt: row.created_at,
      readAt: row.read_at,
      actor: { id: row.actor_id, name: row.actor_name },
    })),
  };
}

export async function markNotificationRead(userId, notificationId) {
  const { rowCount } = await pool.query(
    "UPDATE notifications SET read_at = COALESCE(read_at, CURRENT_TIMESTAMP) WHERE id = $1 AND recipient_id = $2",
    [notificationId, userId]
  );
  return rowCount > 0;
}

export async function markAllNotificationsRead(userId) {
  const { rowCount } = await pool.query(
    "UPDATE notifications SET read_at = CURRENT_TIMESTAMP WHERE recipient_id = $1 AND read_at IS NULL",
    [userId]
  );
  return rowCount;
}


export async function toggleSavedContent(userId, contentId, saved) {
  if (!(await canAccessContent(userId, contentId))) return null;
  if (saved) {
    await pool.query("INSERT INTO saved_content (user_id, content_id) VALUES ($1, $2) ON CONFLICT DO NOTHING", [userId, contentId]);
  } else {
    await pool.query("DELETE FROM saved_content WHERE user_id = $1 AND content_id = $2", [userId, contentId]);
  }
  return { savedByMe: saved };
}

export async function listTribeMembers(userId, tribeId) {
  const { rows } = await pool.query(
    `SELECT u.id, u.display_name,
            CASE WHEN u.id = $1 OR u.profile_visibility->>'aboutMe' = 'public'
              THEN u.about_me ELSE '' END AS about_me,
            CASE WHEN u.id = $1 OR u.profile_visibility->>'city' = 'public'
              THEN u.city ELSE '' END AS city,
            CASE WHEN u.id = $1 OR u.profile_visibility->>'interests' = 'public'
              THEN u.interests ELSE '[]'::jsonb END AS interests,
            m.joined_at,
            EXISTS (SELECT 1 FROM user_profile_images i WHERE i.user_id = u.id AND i.is_deleted = FALSE) AS has_avatar,
            (t.moderator_id = u.id) AS is_moderator
     FROM tribe_memberships m
     JOIN users u ON u.id = m.user_id
     JOIN tribes t ON t.id = m.tribe_id
     WHERE m.tribe_id = $2 AND m.status = 'active'
       AND EXISTS (SELECT 1 FROM tribe_memberships viewer_membership WHERE viewer_membership.tribe_id = $2 AND viewer_membership.user_id = $1 AND viewer_membership.status = 'active')
      ORDER BY (t.moderator_id = u.id) DESC, u.display_name ASC
     LIMIT 200`,
    [userId, tribeId]
  );
  if (rows.length === 0 && !(await userBelongsToTribe(userId, tribeId))) return null;
  return rows.map((row) => ({
    id: row.id, name: row.display_name, aboutMe: row.about_me ?? "", city: row.city ?? "", interests: Array.isArray(row.interests) ? row.interests : [],
    joinedAt: row.joined_at, isModerator: row.is_moderator,
    avatarUrl: row.has_avatar ? `/api/users/${row.id}/avatar` : null,
  }));
}

export async function searchDirectMessageUsers(userId, query, limit = 20) {
  const { rows } = await pool.query(
    `SELECT u.id, u.display_name,
            EXISTS (SELECT 1 FROM user_profile_images image
                    WHERE image.user_id = u.id AND image.is_deleted = FALSE) AS has_avatar
     FROM users u
     WHERE u.id <> $1 AND u.display_name ILIKE $2
     ORDER BY u.display_name ASC, u.id ASC
     LIMIT $3`,
    [userId, `%${query}%`, limit]
  );
  return rows.map((row) => ({
    id: row.id,
    name: row.display_name,
    avatarUrl: row.has_avatar ? `/api/users/${row.id}/avatar` : null,
  }));
}

export async function createOrGetDirectConversation(userId, recipientId) {
  if (userId === recipientId) return null;
  const { rows } = await pool.query(
    `INSERT INTO direct_conversations (user_low_id, user_high_id)
     SELECT LEAST($1::uuid, $2::uuid), GREATEST($1::uuid, $2::uuid)
     WHERE EXISTS (SELECT 1 FROM users WHERE id = $2)
     ON CONFLICT (user_low_id, user_high_id)
     DO UPDATE SET user_low_id = EXCLUDED.user_low_id
     RETURNING id`,
    [userId, recipientId]
  );
  return rows[0] ? { id: rows[0].id } : null;
}

export async function getDirectConversation(userId, conversationId) {
  const { rows } = await pool.query(
    `SELECT conversation.id,
            peer.id AS peer_id, peer.display_name AS peer_name,
            EXISTS (SELECT 1 FROM user_profile_images image
                    WHERE image.user_id = peer.id AND image.is_deleted = FALSE) AS peer_has_avatar
     FROM direct_conversations conversation
     JOIN users peer ON peer.id = CASE WHEN conversation.user_low_id = $1
                                       THEN conversation.user_high_id
                                       ELSE conversation.user_low_id END
     WHERE conversation.id = $2
       AND ($1 = conversation.user_low_id OR $1 = conversation.user_high_id)`,
    [userId, conversationId]
  );
  const row = rows[0];
  return row ? {
    id: row.id,
    peer: {
      id: row.peer_id,
      name: row.peer_name,
      avatarUrl: row.peer_has_avatar ? `/api/users/${row.peer_id}/avatar` : null,
    },
  } : null;
}

export async function listDirectConversations(userId, limit = 100) {
  const { rows } = await pool.query(
    `SELECT conversation.id,
            peer.id AS peer_id, peer.display_name AS peer_name,
            EXISTS (SELECT 1 FROM user_profile_images image
                    WHERE image.user_id = peer.id AND image.is_deleted = FALSE) AS peer_has_avatar,
            latest.body AS last_message_body,
            latest.created_at AS last_message_at,
            (SELECT COUNT(*)::int
             FROM direct_messages unread
             WHERE unread.conversation_id = conversation.id
               AND unread.sender_id = peer.id
               AND unread.created_at > COALESCE(
                 CASE WHEN conversation.user_low_id = $1 THEN conversation.user_low_read_at
                      ELSE conversation.user_high_read_at END,
                 '-infinity'::timestamptz
               )) AS unread_count
     FROM direct_conversations conversation
     JOIN users peer ON peer.id = CASE WHEN conversation.user_low_id = $1
                                       THEN conversation.user_high_id
                                       ELSE conversation.user_low_id END
     LEFT JOIN LATERAL (
       SELECT message.body, message.created_at
       FROM direct_messages message
       WHERE message.conversation_id = conversation.id
       ORDER BY message.created_at DESC, message.id DESC
       LIMIT 1
     ) latest ON TRUE
     WHERE conversation.user_low_id = $1 OR conversation.user_high_id = $1
     ORDER BY latest.created_at DESC NULLS LAST, conversation.created_at DESC
     LIMIT $2`,
    [userId, limit]
  );
  return rows.map((row) => ({
    id: row.id,
    peer: {
      id: row.peer_id,
      name: row.peer_name,
      avatarUrl: row.peer_has_avatar ? `/api/users/${row.peer_id}/avatar` : null,
    },
    lastMessage: row.last_message_body === null ? null : {
      body: row.last_message_body,
      createdAt: row.last_message_at,
    },
    unreadCount: row.unread_count,
  }));
}

export async function listDirectMessages(userId, conversationId, limit = 100) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const { rows: conversations } = await client.query(
      `SELECT user_low_id, user_high_id
       FROM direct_conversations
       WHERE id = $1 AND ($2 = user_low_id OR $2 = user_high_id)
       FOR UPDATE`,
      [conversationId, userId]
    );
    const conversation = conversations[0];
    if (!conversation) {
      await client.query("ROLLBACK");
      return null;
    }
    const readColumn = conversation.user_low_id === userId ? "user_low_read_at" : "user_high_read_at";
    await client.query(`UPDATE direct_conversations SET ${readColumn} = CURRENT_TIMESTAMP WHERE id = $1`, [conversationId]);
    const { rows } = await client.query(
      `SELECT message.id, message.body, message.created_at,
              (message.sender_id = $1) AS is_mine,
              sender.id AS sender_id, sender.display_name AS sender_name,
              EXISTS (SELECT 1 FROM user_profile_images image
                      WHERE image.user_id = sender.id AND image.is_deleted = FALSE) AS sender_has_avatar
       FROM direct_messages message
       JOIN users sender ON sender.id = message.sender_id
       WHERE message.conversation_id = $2
       ORDER BY message.created_at DESC, message.id DESC
       LIMIT $3`,
      [userId, conversationId, limit]
    );
    await client.query("COMMIT");
    return rows.reverse().map(toDirectMessage);
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

export async function createDirectMessage(userId, conversationId, body) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const { rowCount } = await client.query(
      `SELECT 1 FROM direct_conversations
       WHERE id = $1 AND ($2 = user_low_id OR $2 = user_high_id)
       FOR SHARE`,
      [conversationId, userId]
    );
    if (!rowCount) {
      await client.query("ROLLBACK");
      return null;
    }
    const { rows } = await client.query(
      `INSERT INTO direct_messages (conversation_id, sender_id, body)
       VALUES ($1, $2, $3)
       RETURNING id, body, created_at`,
      [conversationId, userId, body]
    );
    const { rows: senders } = await client.query(
      `SELECT u.id AS sender_id, u.display_name AS sender_name,
              EXISTS (SELECT 1 FROM user_profile_images image
                      WHERE image.user_id = u.id AND image.is_deleted = FALSE) AS sender_has_avatar
       FROM users u WHERE u.id = $1`,
      [userId]
    );
    await client.query("COMMIT");
    return toDirectMessage({ ...rows[0], ...senders[0], is_mine: true });
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

function toDirectMessage(row) {
  return {
    id: row.id,
    body: row.body,
    createdAt: row.created_at,
    isMine: row.is_mine === true,
    sender: {
      id: row.sender_id,
      name: row.sender_name,
      avatarUrl: row.sender_has_avatar ? `/api/users/${row.sender_id}/avatar` : null,
    },
  };
}

export async function listTribeMessages(userId, tribeId, limit = 100) {
  const { rows } = await pool.query(
    `SELECT message.id, message.body, message.created_at, message.edited_at,
            (message.user_id = $1) AS is_mine,
            author.id AS author_id, author.display_name AS author_name,
            EXISTS (SELECT 1 FROM user_profile_images image
                    WHERE image.user_id = author.id AND image.is_deleted = FALSE) AS author_has_avatar
     FROM tribe_messages message
     JOIN users author ON author.id = message.user_id
     JOIN tribe_memberships membership
       ON membership.tribe_id = message.tribe_id
      AND membership.user_id = $1
      AND membership.status = 'active'
     WHERE message.tribe_id = $2
       AND message.created_at >= CURRENT_TIMESTAMP - INTERVAL '7 days'
     ORDER BY message.created_at DESC, message.id DESC
     LIMIT $3`,
    [userId, tribeId, limit]
  );
  if (rows.length === 0 && !(await userBelongsToTribe(userId, tribeId))) return null;
  return rows.reverse().map(toTribeMessage);
}

export async function createTribeMessage(userId, tribeId, body) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const { rowCount } = await client.query(
      `SELECT 1 FROM tribe_memberships
       WHERE user_id = $1 AND tribe_id = $2 AND status = 'active'
       FOR SHARE`,
      [userId, tribeId]
    );
    if (!rowCount) {
      await client.query("ROLLBACK");
      return null;
    }
    const { rows } = await client.query(
      `INSERT INTO tribe_messages (tribe_id, user_id, body)
       VALUES ($1, $2, $3)
       RETURNING id, body, created_at`,
      [tribeId, userId, body]
    );
    const { rows: authors } = await client.query(
      `SELECT u.id AS author_id, u.display_name AS author_name,
              EXISTS (SELECT 1 FROM user_profile_images image
                      WHERE image.user_id = u.id AND image.is_deleted = FALSE) AS author_has_avatar
       FROM users u WHERE u.id = $1`,
      [userId]
    );
    await client.query("COMMIT");
    return toTribeMessage({ ...rows[0], ...authors[0], is_mine: true });
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

function toTribeMessage(row) {
  return {
    id: row.id,
    body: row.body,
    createdAt: row.created_at,
    editedAt: row.edited_at ?? null,
    isMine: row.is_mine === true,
    author: {
      id: row.author_id,
      name: row.author_name,
      avatarUrl: row.author_has_avatar ? `/api/users/${row.author_id}/avatar` : null,
    },
  };
}

export async function updateTribeMessage(userId, tribeId, messageId, body) {
  const { rows } = await pool.query(
    `UPDATE tribe_messages AS message
     SET body = $4, edited_at = CURRENT_TIMESTAMP
     FROM tribe_memberships AS membership
     WHERE message.id = $1
       AND message.tribe_id = $2
       AND message.user_id = $3
       AND membership.tribe_id = message.tribe_id
       AND membership.user_id = $3
       AND membership.status = 'active'
     RETURNING message.id, message.body, message.edited_at`,
    [messageId, tribeId, userId, body]
  );
  return rows[0] ?? null;
}

export async function deleteTribeMessage(userId, tribeId, messageId) {
  const { rowCount } = await pool.query(
    `DELETE FROM tribe_messages AS message
     USING tribe_memberships AS membership
     WHERE message.id = $1
       AND message.tribe_id = $2
       AND message.user_id = $3
       AND membership.tribe_id = message.tribe_id
       AND membership.user_id = $3
       AND membership.status = 'active'`,
    [messageId, tribeId, userId]
  );
  return rowCount > 0;
}

export async function deleteExpiredTribeMessages() {
  const { rowCount } = await pool.query(
    "DELETE FROM tribe_messages WHERE created_at < CURRENT_TIMESTAMP - INTERVAL '7 days'"
  );
  return rowCount;
}

export async function listUpcomingEvents(userId, limit = 100, { query = "", tribeId, from, to, attendingOnly = false } = {}) {
  const normalizedQuery = query.trim();
  const { rows } = await pool.query(
    `SELECT f.id, f.body, e.title, e.starts_at, e.ends_at, e.location, e.location_lat, e.location_lon, e.cost, e.max_attendees,
            t.id AS tribe_id, t.name AS tribe_name, u.display_name AS author_name,
            (SELECT COUNT(*) FROM event_attendees a WHERE a.content_id = f.id)::int AS attendees_count,
            EXISTS (SELECT 1 FROM event_attendees a WHERE a.content_id = f.id AND a.user_id = $1) AS attending_by_me,
            (SELECT COUNT(*) FROM event_waitlist w WHERE w.content_id = f.id)::int AS waitlist_count,
            EXISTS (SELECT 1 FROM event_waitlist w WHERE w.content_id = f.id AND w.user_id = $1) AS waitlisted_by_me
     FROM feed_items f JOIN tribe_events e ON e.content_id = f.id
     JOIN tribes t ON t.id = f.tribe_id JOIN users u ON u.id = f.author_id
     JOIN tribe_memberships m ON m.tribe_id = f.tribe_id AND m.user_id = $1 AND m.status = 'active'
      WHERE (($3::timestamptz IS NULL AND e.starts_at >= CURRENT_TIMESTAMP)
          OR ($3::timestamptz IS NOT NULL AND e.starts_at < $4 AND COALESCE(e.ends_at, e.starts_at) >= $3))
        AND ($5::uuid IS NULL OR f.tribe_id = $5)
        AND ($6::text IS NULL OR (
          f.body ILIKE $6 OR e.title ILIKE $6 OR e.location ILIKE $6 OR t.name ILIKE $6
        ))
        AND (NOT $7::boolean OR EXISTS (
          SELECT 1 FROM event_attendees a WHERE a.content_id = f.id AND a.user_id = $1
        ))
       ORDER BY e.starts_at ASC, f.id ASC LIMIT COALESCE($2::integer, 2147483647)`,
    [userId, limit, from ?? null, to ?? null, tribeId ?? null, normalizedQuery ? `%${normalizedQuery}%` : null, attendingOnly]
  );
  return rows.map((row) => ({
    id: row.id, body: row.body, title: row.title, startsAt: row.starts_at, endsAt: row.ends_at,
    location: row.location, lat: row.location_lat, lon: row.location_lon, cost: row.cost, maxAttendees: row.max_attendees,
    tribe: { id: row.tribe_id, name: row.tribe_name }, authorName: row.author_name,
    attendeesCount: row.attendees_count, waitlistCount: row.waitlist_count,
    attendingByMe: row.attending_by_me, waitlistedByMe: row.waitlisted_by_me,
  }));
}
