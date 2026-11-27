import test from "node:test";
import assert from "node:assert/strict";
import { Readable } from "node:stream";
import { readJson, sendJson } from "../http-utils.mjs";

test("readJson parses object payloads and rejects non-objects", async () => {
  assert.deepEqual(await readJson(Readable.from([Buffer.from('{"name":"Tribes"}')])), { name: "Tribes" });
  await assert.rejects(
    readJson(Readable.from([Buffer.from("null")])),
    { statusCode: 400, message: "Objeto JSON inválido." }
  );
  assert.equal(await readJson(Readable.from([Buffer.from("null")]), { requireObject: false }), null);
});

test("readJson preserves custom parse errors and payload-size limits", async () => {
  await assert.rejects(
    readJson(Readable.from([Buffer.from("{")]), { invalidMessage: "Payload JSON inválido." }),
    { statusCode: 400, message: "Payload JSON inválido." }
  );
  await assert.rejects(
    readJson(Readable.from([Buffer.from("1234")]), { maxSize: 3 }),
    { statusCode: 413, code: "invalid_payload", message: "Payload muito grande." }
  );
});

test("sendJson applies shared response headers and serializes the payload", () => {
  let statusCode;
  let headers;
  let body;
  sendJson({
    writeHead(status, responseHeaders) {
      statusCode = status;
      headers = responseHeaders;
    },
    end(responseBody) {
      body = responseBody;
    },
  }, 201, { ok: true }, { "Set-Cookie": "session=token" });

  assert.equal(statusCode, 201);
  assert.equal(headers["Content-Type"], "application/json; charset=utf-8");
  assert.equal(headers["Cache-Control"], "no-store");
  assert.equal(headers["Set-Cookie"], "session=token");
  assert.equal(body, '{"ok":true}');
});
