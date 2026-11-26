import { sendEmail } from "./email-provider.mjs";

function escapeHtml(value) {
  return value.replace(/[&<>"']/g, char => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]);
}

export async function sendTribeInvitationEmail(email, token, inviterName, tribeName, options = {}) {
  const url = new URL("/convite", (options.env ?? process.env).FRONTEND_URL ?? "http://localhost:4317");
  url.hash = new URLSearchParams({ token }).toString();
  const inviter = escapeHtml(inviterName);
  const tribe = escapeHtml(tribeName);
  await sendEmail({
    to: email,
    textEncoding: "base64",
    subject: "Você recebeu um convite para uma tribo",
    text: `Olá!\n\n${inviterName} convidou você para participar da comunidade ${tribeName} no Tribes.\n\nCrie sua conta gratuitamente para conhecer a comunidade e decidir se deseja participar. O convite é válido por 7 dias.\n\nAceitar convite: ${url.href}`,
    html: `<p>Olá!</p><p>${inviter} convidou você para participar da comunidade <strong>${tribe}</strong> no Tribes.</p><p>Crie sua conta gratuitamente para conhecer a comunidade e decidir se deseja participar. O convite é válido por 7 dias.</p><p><a href="${escapeHtml(url.href)}">Aceitar convite</a></p>`,
  }, options);
}
