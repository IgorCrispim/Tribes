import "./load-env.mjs";
import { pathToFileURL } from "node:url";
import { partnerStore, closePartnerStore } from "./partner-store.mjs";
import { PartnerError, partnerInvalid } from "./partner-security.mjs";

const commands = {
  "create-partner": ["slug", "name"],
  "create-application": ["partner", "slug", "name", "scopes", "requests-per-minute"],
  "issue-key": ["application", "label", "scopes", "expires-at"],
  "revoke-key": ["key"],
  "rotate-key": ["key", "expires-at"],
  "set-partner-status": ["partner", "status"],
  "set-application-status": ["application", "status"],
};

export async function runPartnerAdmin(argv, store = partnerStore) {
  const [command, ...args] = argv;
  if (!Object.hasOwn(commands, command ?? "")) throw partnerInvalid(`Comando inválido. Disponíveis: ${Object.keys(commands).join(", ")}.`);
  const values = {};
  for (let index = 0; index < args.length; index += 2) {
    const flag = args[index];
    const value = args[index + 1];
    if (!flag?.startsWith("--") || !commands[command].includes(flag.slice(2)) || !value || value.startsWith("--") || Object.hasOwn(values, flag.slice(2))) {
      throw partnerInvalid("Argumentos inválidos, desconhecidos ou repetidos.");
    }
    values[flag.slice(2)] = value;
  }
  const scopes = values.scopes?.split(",");
  switch (command) {
    case "create-partner": return { partner: await store.createPartner({ slug: values.slug, name: values.name }) };
    case "create-application": return { application: await store.createApplication({ partnerId: values.partner, slug: values.slug, name: values.name, scopes, requestsPerMinute: values["requests-per-minute"] === undefined ? 120 : Number(values["requests-per-minute"]) }) };
    case "issue-key": return store.issueKey({ applicationId: values.application, label: values.label, scopes, expiresAt: values["expires-at"] });
    case "revoke-key": return { credential: await store.revokeKey(values.key) };
    case "rotate-key": return store.rotateKey(values.key, values["expires-at"]);
    case "set-partner-status": return { partner: await store.setStatus("partner", values.partner, values.status) };
    case "set-application-status": return { application: await store.setStatus("application", values.application, values.status) };
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const result = await runPartnerAdmin(process.argv.slice(2));
    // Only issuance/rotation exposes a secret, once, to the operator's stdout.
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } catch (error) {
    process.stderr.write(`${JSON.stringify({ error: error instanceof PartnerError ? error.message : "Falha na operação de parceiros. Verifique o banco e as migrations.", code: error instanceof PartnerError ? error.code : "operation_failed" })}\n`);
    process.exitCode = 1;
  } finally { await closePartnerStore(); }
}
