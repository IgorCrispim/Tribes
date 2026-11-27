export function sendJson(response, statusCode, data, headers = {}) {
  response.writeHead(statusCode, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    ...headers,
  });
  response.end(JSON.stringify(data));
}

export async function readJson(request, {
  maxSize = 64 * 1024,
  requireObject = true,
  invalidMessage = "Objeto JSON inválido.",
} = {}) {
  const chunks = [];
  let size = 0;

  for await (const chunk of request) {
    size += chunk.length;
    if (size > maxSize) {
      const error = new Error("Payload muito grande.");
      error.statusCode = 413;
      error.code = "invalid_payload";
      throw error;
    }
    chunks.push(chunk);
  }

  let value;
  try {
    value = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    const error = new Error(invalidMessage);
    error.statusCode = 400;
    throw error;
  }

  if (requireObject && (!value || typeof value !== "object" || Array.isArray(value))) {
    const error = new Error(invalidMessage);
    error.statusCode = 400;
    throw error;
  }

  return value;
}
