import test from "node:test";
import assert from "node:assert/strict";
import { sendRegistrationEmail } from "../registration-email.mjs";
import { sendPasswordResetEmail } from "../password-reset-email.mjs";
import { sendTribeInvitationEmail } from "../tribe-invitation-email.mjs";
import { EmailDeliveryError } from "../email-provider.mjs";

const registrationToken = "registration-token-test-value";
const resetToken = "password-reset-token-test-value";

test("tribe invitation uses the existing provider and safely includes its destination", async () => {
  const sent = [];
  const env = { EMAIL_PROVIDER: "mailhog", EMAIL_FROM: "Tribes <no-reply@tribes.local>", FRONTEND_URL: "https://tribes.example.test" };
  await sendTribeInvitationEmail("invited@example.test", "secret-token", "Ana <Admin>", "Clube & Amigos", {
    env, createTransport: () => ({ async sendMail(message) { sent.push(message); } }),
  });
  assert.equal(sent.length, 1);
  assert.equal(sent[0].to, "invited@example.test");
  assert.match(sent[0].text, /Ana <Admin> convidou você/);
  assert.match(sent[0].text, /Clube & Amigos/);
  assert.match(sent[0].html, /Ana &lt;Admin&gt;/);
  assert.match(sent[0].html, /Clube &amp; Amigos/);
  const url = sent[0].text.match(/https:\/\/[^\s]+/)[0];
  assert.equal(new URL(url).pathname, "/convite");
  assert.equal(new URLSearchParams(new URL(url).hash.slice(1)).get("token"), "secret-token");
  assert.equal(new URL(url).search, "");
});

function getLink(body, path) {
  const match = body.match(new RegExp(`https?:\\/\\/[^\\s<"]+${path}\\?token=[^\\s<"]+`));
  assert.ok(match, `email must contain a link to ${path}`);
  return match[0];
}

test("MailHog selection routes both auth emails through its SMTP transport", async () => {
  const sent = [];
  const env = {
    EMAIL_PROVIDER: "mailhog",
    EMAIL_FROM: "Tribes <no-reply@tribes.local>",
    SMTP_URL: "smtp://mailhog:1025",
    FRONTEND_URL: "http://localhost:4317",
  };
  const createTransport = (smtpUrl) => ({
    async sendMail(message) {
      sent.push({ smtpUrl, message });
    },
  });
  const options = { env, createTransport };

  await sendRegistrationEmail("new@example.test", registrationToken, options);
  await sendPasswordResetEmail("member@example.test", resetToken, options);

  assert.equal(sent.length, 2);
  assert.deepEqual(sent.map(({ smtpUrl }) => smtpUrl), ["smtp://mailhog:1025", "smtp://mailhog:1025"]);
  assert.equal(sent[0].message.from, env.EMAIL_FROM);
  assert.equal(sent[0].message.to, "new@example.test");
  assert.equal(sent[0].message.subject, "Crie sua conta na Tribes");
  assert.equal(new URL(getLink(sent[0].message.text, "/cadastro/confirmar")).searchParams.get("token"), registrationToken);
  assert.match(sent[0].message.text, /válido por 24 horas/);
  assert.match(sent[0].message.html, /válido por 24 horas/);
  assert.equal(sent[1].message.from, env.EMAIL_FROM);
  assert.equal(sent[1].message.to, "member@example.test");
  assert.equal(sent[1].message.subject, "Redefina sua senha da Tribes");
  assert.equal(new URL(getLink(sent[1].message.text, "/senha/redefinir")).searchParams.get("token"), resetToken);
  assert.match(sent[1].message.text, /válido por 30 minutos/);
});

test("Resend submits registration and password-reset emails to its HTTPS API", async () => {
  const requests = [];
  const apiKey = "re_test_key_that_is_not_real";
  const env = {
    EMAIL_PROVIDER: "resend",
    RESEND_API_KEY: apiKey,
    EMAIL_FROM: "Tribes <onboarding@resend.dev>",
    FRONTEND_URL: "https://tribes.example.test",
    NODE_ENV: "test",
  };
  const fetchImpl = async (url, request) => {
    requests.push({ url, request });
    return { ok: true, status: 200 };
  };
  const options = { env, fetchImpl };

  await sendRegistrationEmail("account-owner@example.test", registrationToken, options);
  await sendPasswordResetEmail("account-owner@example.test", resetToken, options);

  assert.equal(requests.length, 2);
  for (const { url, request } of requests) {
    assert.equal(url, "https://api.resend.com/emails");
    assert.equal(request.method, "POST");
    assert.equal(request.headers.Authorization, `Bearer ${apiKey}`);
    assert.equal(request.headers["Content-Type"], "application/json");
  }
  const registration = JSON.parse(requests[0].request.body);
  assert.equal(registration.from, env.EMAIL_FROM);
  assert.equal(registration.to, "account-owner@example.test");
  assert.equal(registration.subject, "Crie sua conta na Tribes");
  assert.equal("textEncoding" in registration, false);
  assert.equal(new URL(getLink(registration.text, "/cadastro/confirmar")).searchParams.get("token"), registrationToken);
  const reset = JSON.parse(requests[1].request.body);
  assert.equal(reset.from, env.EMAIL_FROM);
  assert.equal(reset.to, "account-owner@example.test");
  assert.equal(reset.subject, "Redefina sua senha da Tribes");
  assert.equal("textEncoding" in reset, false);
  assert.equal(new URL(getLink(reset.text, "/senha/redefinir")).searchParams.get("token"), resetToken);
});

test("Resend failures are clear and do not expose provider responses or credentials", async () => {
  const apiKey = "re_secret_test_value";
  const secretProviderMessage = `request failed with ${apiKey}`;
  const options = {
    env: {
      EMAIL_PROVIDER: "resend",
      RESEND_API_KEY: apiKey,
      EMAIL_FROM: "Tribes <onboarding@resend.dev>",
      NODE_ENV: "test",
    },
    fetchImpl: async () => ({
      ok: false,
      status: 403,
      async text() { return secretProviderMessage; },
    }),
  };

  await assert.rejects(
    sendRegistrationEmail("account-owner@example.test", registrationToken, options),
    (error) => {
      assert.ok(error instanceof EmailDeliveryError);
      assert.equal(error.statusCode, 503);
      assert.match(error.message, /Resend recusou o envio.*HTTP 403/);
      assert.doesNotMatch(error.message, /re_secret_test_value|request failed/);
      assert.equal(error.cause, undefined);
      return true;
    }
  );
});

test("Resend quota rejections expose their machine-readable error codes", async () => {
  await assert.rejects(
    sendRegistrationEmail("new@example.test", registrationToken, {
      env: {
        EMAIL_PROVIDER: "resend",
        RESEND_API_KEY: "re_test_key_that_is_not_real",
        EMAIL_FROM: "Tribes <onboarding@resend.dev>",
        NODE_ENV: "test",
      },
      fetchImpl: async () => ({
        ok: false,
        status: 429,
        async json() { return { statusCode: 429, name: "daily_quota_exceeded" }; },
      }),
    }),
    (error) => {
      assert.ok(error instanceof EmailDeliveryError);
      assert.equal(error.providerCode, "daily_quota_exceeded");
      assert.equal(error.retryable, true);
      return true;
    }
  );
});

test("Resend requires a backend key and rejects its test sender in production", async () => {
  let fetchCalled = false;
  const fetchImpl = async () => {
    fetchCalled = true;
    return { ok: true, status: 200 };
  };

  await assert.rejects(
    sendPasswordResetEmail("account-owner@example.test", resetToken, {
      env: { EMAIL_PROVIDER: "resend", EMAIL_FROM: "Tribes <onboarding@resend.dev>" },
      fetchImpl,
    }),
    { statusCode: 503, message: "RESEND_API_KEY não está configurada no backend." }
  );
  await assert.rejects(
    sendPasswordResetEmail("account-owner@example.test", resetToken, {
      env: {
        EMAIL_PROVIDER: "resend",
        RESEND_API_KEY: "re_test_key_that_is_not_real",
        EMAIL_FROM: "Tribes <onboarding@resend.dev>",
        NODE_ENV: "production",
      },
      fetchImpl,
    }),
    { statusCode: 503, message: "O remetente onboarding@resend.dev só pode ser usado em testes." }
  );
  assert.equal(fetchCalled, false);
});

test("unknown email providers fail without attempting SMTP or HTTPS", async () => {
  await assert.rejects(
    sendRegistrationEmail("new@example.test", registrationToken, {
      env: { EMAIL_PROVIDER: "unknown" },
      createTransport() { assert.fail("SMTP must not be contacted"); },
      fetchImpl() { assert.fail("HTTPS must not be contacted"); },
    }),
    { statusCode: 503, message: "EMAIL_PROVIDER deve ser mailhog ou resend." }
  );
});
