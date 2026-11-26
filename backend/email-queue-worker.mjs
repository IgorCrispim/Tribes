import { randomBytes } from "node:crypto";
import {
  acquireEmailQueueWorkerLock,
  claimNextEmail,
  completeEmailQueueItem,
  createPasswordResetToken,
  createRegistrationToken,
  deletePasswordResetToken,
  deleteRegistrationToken,
  failEmailQueueItem,
  getEmailQueuePause,
  getUserByEmail,
  pauseEmailQueue,
  prepareInvitationEmail,
  releaseEmailQueueWorkerLock,
  retryEmailQueueItem,
} from "./social-store.mjs";
import { digestSessionToken } from "./security.mjs";
import { EmailDeliveryError } from "./email-provider.mjs";
import { sendRegistrationEmail } from "./registration-email.mjs";
import { sendPasswordResetEmail } from "./password-reset-email.mjs";
import { sendTribeInvitationEmail } from "./tribe-invitation-email.mjs";

const REGISTRATION_TOKEN_TTL_MS = 24 * 60 * 60 * 1000;
const PASSWORD_RESET_TOKEN_TTL_MS = 30 * 60 * 1000;
const POLL_INTERVAL_MS = 1000;
const SEND_INTERVAL_MS = 150;
const MAX_RETRY_DELAY_MS = 60 * 60 * 1000;

let workerTimer;
let workerRunning = false;
let rerunRequested = false;

export function nextResendQuotaReset(providerCode, now = new Date()) {
  if (providerCode === "daily_quota_exceeded") {
    return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1));
  }
  if (providerCode === "monthly_quota_exceeded") {
    return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1));
  }
  return null;
}

function backoffDelay(attempts) {
  return Math.min(30_000 * (2 ** Math.min(attempts, 7)), MAX_RETRY_DELAY_MS);
}

async function processNextEmail() {
  const lockClient = await acquireEmailQueueWorkerLock();
  if (!lockClient) return "busy";

  try {
    if (await getEmailQueuePause()) return "paused";
    const item = await claimNextEmail();
    if (!item) return "empty";

    if (item.kind === "registration" && await getUserByEmail(item.email)) {
      await completeEmailQueueItem(item.id, "skipped");
      return "skipped";
    }

    const token = randomBytes(32).toString("base64url");
    const tokenHash = digestSessionToken(token);
    const expiresAt = new Date(Date.now() + (
      item.kind === "registration" ? REGISTRATION_TOKEN_TTL_MS : PASSWORD_RESET_TOKEN_TTL_MS
    ));

    let invitation;
    if (item.kind === "tribe_invitation") {
      invitation = await prepareInvitationEmail(item.invitation_id, tokenHash);
      if (!invitation) { await completeEmailQueueItem(item.id, "skipped"); return "skipped"; }
    } else if (item.kind === "registration") {
      const created = await createRegistrationToken({ email: item.email, tokenHash, expiresAt, invitationId: item.invitation_id, queueId: item.id });
      if (!created) {
        await completeEmailQueueItem(item.id, "skipped");
        return "skipped";
      }
    } else {
      const created = await createPasswordResetToken({ email: item.email, tokenHash, expiresAt });
      if (created === null) {
        await completeEmailQueueItem(item.id, "skipped");
        return "skipped";
      }
    }

    try {
      if (item.kind === "registration") {
        await sendRegistrationEmail(item.email, token);
      } else if (item.kind === "password_reset") {
        await sendPasswordResetEmail(item.email, token);
      } else {
        await sendTribeInvitationEmail(invitation.email, token, invitation.inviter_name, invitation.tribe_name);
      }
      await completeEmailQueueItem(item.id);
      return "sent";
    } catch (error) {
      const providerCode = error instanceof EmailDeliveryError ? error.providerCode : null;
      const quotaReset = nextResendQuotaReset(providerCode);
      if (quotaReset) {
        if (item.kind === "registration") await deleteRegistrationToken(tokenHash);
        else if (item.kind === "password_reset") await deletePasswordResetToken(tokenHash);
        await pauseEmailQueue(quotaReset, providerCode);
        await retryEmailQueueItem(item.id, quotaReset.getTime() - Date.now(), error.message, {
          incrementAttempts: false,
        });
        console.info(`Fila de email pausada até ${quotaReset.toISOString()} (${providerCode}).`);
        return "paused";
      }

      if (error instanceof EmailDeliveryError && !error.retryable) {
        if (item.kind === "registration") await deleteRegistrationToken(tokenHash);
        else if (item.kind === "password_reset") await deletePasswordResetToken(tokenHash);
        await failEmailQueueItem(item.id, error.message);
        console.error(`Email da fila ${item.id} rejeitado permanentemente: ${error.message}`);
        return "deferred";
      }

      await retryEmailQueueItem(item.id, backoffDelay(item.attempts), error.message);
      console.error(`Falha temporária no email da fila ${item.id}: ${error.message}`);
      return "deferred";
    }
  } finally {
    await releaseEmailQueueWorkerLock(lockClient);
  }
}

async function runWorker() {
  if (workerRunning) {
    rerunRequested = true;
    return;
  }
  workerRunning = true;
  try {
    let result;
    do {
      rerunRequested = false;
      result = await processNextEmail();
      if (result === "sent" || result === "skipped" || result === "deferred") {
        await new Promise((resolve) => setTimeout(resolve, SEND_INTERVAL_MS));
      }
    } while (["sent", "skipped", "deferred"].includes(result) || rerunRequested);
  } catch (error) {
    console.error("Falha ao processar a fila de emails:", error);
  } finally {
    workerRunning = false;
    if (rerunRequested) setTimeout(() => void runWorker(), 0);
  }
}

export function startEmailQueueWorker() {
  if (workerTimer) return;
  workerTimer = setInterval(() => void runWorker(), POLL_INTERVAL_MS);
  void runWorker();
}

export function wakeEmailQueueWorker() {
  void runWorker();
}
