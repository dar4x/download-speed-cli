const TIMEOUT_MS = 30_000;

// fetch обычно оборачивает сетевую ошибку в TypeError: код находится в cause.
function describeError(error, phase) {
  const cause = error.cause ?? error;
  const code = cause.code ?? error.code;

  if (error.name === "TimeoutError") {
    return "Request timed out after 30 seconds (including body download).";
  }
  if (error.name === "AbortError") {
    return "Request was cancelled.";
  }

  const messages = {
    ENOTFOUND: "DNS lookup failed: hostname was not found.",
    EAI_AGAIN: "DNS lookup temporarily failed. Try again later.",
    ECONNREFUSED: "Connection refused by the server.",
    ENETUNREACH: "Network is unreachable.",
    EHOSTUNREACH: "Server is unreachable.",
    ECONNRESET: "Connection was reset before the download completed.",
    EPIPE: "Connection closed unexpectedly.",
    ETIMEDOUT: "Network operation timed out.",
    UND_ERR_CONNECT_TIMEOUT: "Connection to the server timed out.",
    UND_ERR_HEADERS_TIMEOUT: "Timed out waiting for response headers.",
    UND_ERR_BODY_TIMEOUT: "Timed out waiting for response body data.",
    UND_ERR_SOCKET: "Connection closed before the download completed.",
    UND_ERR_RES_CONTENT_LENGTH_MISMATCH:
      "Response body is incomplete: size does not match Content-Length.",
    UND_ERR_HEADERS_OVERFLOW:
      "Server returned response headers that are too large.",
    ERR_SSL_WRONG_VERSION_NUMBER:
      "TLS connection failed: server does not support the expected HTTPS protocol.",
    DEPTH_ZERO_SELF_SIGNED_CERT:
      "TLS certificate is self-signed and is not trusted.",
    SELF_SIGNED_CERT_IN_CHAIN:
      "TLS certificate chain contains an untrusted self-signed certificate.",
    UNABLE_TO_VERIFY_LEAF_SIGNATURE: "TLS certificate could not be verified.",
    UNABLE_TO_GET_ISSUER_CERT_LOCALLY: "TLS certificate issuer is not trusted.",
  };

  if (Object.hasOwn(messages, code)) return messages[code];
  if (code?.startsWith("CERT_") || code?.startsWith("ERR_TLS_")) {
    return `TLS certificate or handshake validation failed (${code}).`;
  }
  if (cause.message === "redirect count exceeded") {
    return "Too many HTTP redirects (possible redirect loop).";
  }
  if (error instanceof RangeError) {
    return "Response body is too large to store in an ArrayBuffer.";
  }
  if (phase === "body") {
    return "Could not read the full response body: interrupted transfer, invalid compression or another read error.";
  }

  // Неизвестные ошибки тоже дают ненулевой код выхода, а не ложный успех.
  return `Request failed unexpectedly (${code ?? error.name ?? "unknown error"}).`;
}

async function main() {
  const args = process.argv.slice(2);
  if (args.length !== 1 || !args[0].trim()) {
    console.error(
      'Provide exactly one URL. Usage: npm start -- "https://host/file"',
    );
    process.exitCode = 1;
    return;
  }

  let url;

  try {
    url = new URL(args[0]);
  } catch {
    console.error(
      "Invalid URL. Provide a complete address starting with http:// or https://.",
    );
    process.exitCode = 1;
    return;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    console.error("Unsupported URL protocol. Only HTTP and HTTPS are allowed.");
    process.exitCode = 1;
    return;
  }
  if (url.username || url.password) {
    console.error("URLs containing a username or password are not supported.");
    process.exitCode = 1;
    return;
  }
  let totalTime = 0;
  let totalByte = 0;
  for (let i = 0; i < 10; i++) {
    const controller = new AbortController();
    const signal = AbortSignal.any([
      controller.signal,
      AbortSignal.timeout(TIMEOUT_MS),
    ]);
    const interrupt = () => controller.abort();
    process.once("SIGINT", interrupt);
    let phase = "request";

    try {
      let startedAt = performance.now();
      let response;

      response = await fetch(url, { signal });
      if (!response.ok) {
        console.error(
          `HTTP request failed: ${response.status} ${response.statusText}`.trim(),
        );
        process.exitCode = 1;
        controller.abort();
        return;
      }

      phase = "body";
      const body = await response.arrayBuffer();
      let performanceTime = (performance.now() - startedAt) / 1000;

      totalTime += performanceTime;
      totalByte += body.byteLength;
    } catch (error) {
      console.error(
        describeError(signal.aborted ? signal.reason : error, phase),
      );
      process.exitCode = controller.signal.aborted ? 130 : 1;
      return;
    } finally {
      process.removeListener("SIGINT", interrupt);
    }
  }

  console.log("average time:", (totalTime / 10).toFixed(3), "s");
  console.log("bytes in overall:", totalByte);
  console.log("speed:", (totalByte * 8) / totalTime / 1000000, "Mbps");
}

await main();
