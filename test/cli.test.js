import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createServer } from "node:http";
import { after, before, test } from "node:test";
import { promisify } from "node:util";

const exec = promisify(execFile);
const script = new URL("../src/index.js", import.meta.url).pathname;
let server;
let baseUrl;
let sequenceStats;
let lateFailureRequests = 0;

function readMetrics(stdout) {
  const average = stdout.match(/^average time: ([\d.]+) s$/m);
  const bytes = stdout.match(/^bytes in overall: (\d+)$/m);
  const speed = stdout.match(/^speed: ([\d.eE+-]+) Mbps$/m);
  assert.ok(average && bytes && speed, `Missing measurement or units: ${stdout}`);
  const result = {
    average: Number(average[1]),
    bytes: Number(bytes[1]),
    speed: Number(speed[1]),
  };
  assert.ok(Object.values(result).every(Number.isFinite));
  return result;
}

async function run(args = [], preload = "") {
  const flags = preload
    ? ["--import", `data:text/javascript,${encodeURIComponent(preload)}`]
    : [];
  try {
    const result = await exec(process.execPath, [...flags, script, ...args], {
      timeout: 5_000,
    });
    return { ...result, code: 0 };
  } catch (error) {
    // Зависший или аварийно убитый процесс — ошибка самого теста.
    if (typeof error.code !== "number") throw error;
    return error;
  }
}

function expectFailure(result, message, code = 1) {
  assert.equal(result.code, code, result.stderr);
  assert.equal(result.stdout, "", "Failed downloads must not print a byte count");
  assert.match(result.stderr, message);
  assert.doesNotMatch(result.stderr, /\n\s+at /, "Expected a readable error without a stack trace");
}

before(async () => {
  server = createServer((req, res) => {
    if (req.url === "/ok") {
      res.write(Buffer.alloc(123));
      setTimeout(() => res.end(Buffer.alloc(333)), 20);
    } else if (req.url === "/empty") {
      res.writeHead(204).end();
    } else if (req.url === "/sequence") {
      const stats = sequenceStats;
      const size = 100 + ++stats.requests;
      stats.active++;
      stats.maxActive = Math.max(stats.maxActive, stats.active);
      res.once("finish", () => {
        stats.active--;
        stats.completed++;
      });
      // Заголовки приходят сразу, но тело остаётся незавершённым ещё 40 мс.
      res.write(Buffer.alloc(1));
      setTimeout(() => res.end(Buffer.alloc(size - 1)), 40);
    } else if (req.url === "/late-failure") {
      lateFailureRequests++;
      if (lateFailureRequests === 7) res.writeHead(503).end("Unavailable");
      else res.end(Buffer.alloc(100));
    } else if (req.url.startsWith("/status/")) {
      res.writeHead(Number(req.url.split("/")[2]));
      res.write("Error body intentionally stays open");
    } else if (req.url === "/redirect") {
      res.writeHead(302, { Location: "/redirect" }).end();
    } else if (req.url === "/broken-body") {
      res.writeHead(200, { "Content-Length": "1000" });
      res.write("partial");
      setTimeout(() => res.destroy(), 20);
    } else if (req.url === "/bad-gzip") {
      res.writeHead(200, { "Content-Encoding": "gzip" }).end("not gzip");
    } else if (req.url === "/slow-headers") {
      // Ожидаем отмену клиента.
    } else if (req.url === "/slow-body") {
      res.writeHead(200);
      res.write("partial");
    } else {
      res.writeHead(404).end();
    }
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  server.closeAllConnections();
  await new Promise(resolve => server.close(resolve));
});

test("reads all chunks of ten responses before reporting totals", async () => {
  const result = await run([`${baseUrl}/ok`]);
  assert.equal(result.code, 0, result.stderr);
  const metrics = readMetrics(result.stdout);
  assert.equal(metrics.bytes, 4560);
  assert.ok(metrics.average >= 0.015, "Response body delay must be included in elapsed time");
  assert.ok(metrics.speed > 0);
  assert.equal(result.stderr, "");
});

test("accepts an empty successful response", async () => {
  const result = await run([`${baseUrl}/empty`]);
  assert.equal(result.code, 0, result.stderr);
  const metrics = readMetrics(result.stdout);
  assert.equal(metrics.bytes, 0);
  assert.equal(metrics.speed, 0);
});

test("makes exactly ten sequential requests to the same URL", async () => {
  sequenceStats = { requests: 0, active: 0, maxActive: 0, completed: 0 };
  const result = await run([`${baseUrl}/sequence`]);
  assert.equal(result.code, 0, result.stderr);
  assert.equal(readMetrics(result.stdout).bytes, 1055);
  assert.deepEqual(sequenceStats, { requests: 10, active: 0, maxActive: 1, completed: 10 });
});

test("calculates average time and Mbps from totals using known durations", async () => {
  const preload = `
    let calls = 0;
    let now = 0;
    let requests = 0;
    performance.now = () => {
      const index = calls++;
      if (index % 2 === 1) now += ((index + 1) / 2) * 100;
      return now;
    };
    globalThis.fetch = async () => {
      const byteLength = ++requests * 100000;
      return { ok: true, arrayBuffer: async () => ({ byteLength }) };
    };
  `;
  const result = await run([`${baseUrl}/ok`], preload);
  assert.equal(result.code, 0, result.stderr);
  // Длительности 0.1..1.0 с, объёмы 100000..1000000 байт.
  assert.deepEqual(readMetrics(result.stdout), { average: 0.55, bytes: 5500000, speed: 8 });
});

test("stops on the seventh failure without printing a partial measurement", async () => {
  lateFailureRequests = 0;
  expectFailure(await run([`${baseUrl}/late-failure`]), /HTTP request failed: 503/);
  assert.equal(lateFailureRequests, 7);
});

for (const args of [[], [""], ["   "], ["http://host", "extra"]]) {
  test(`rejects missing, empty or extra arguments: ${JSON.stringify(args)}`, async () => {
    expectFailure(await run(args), /Provide exactly one URL/);
  });
}

for (const url of ["not-a-url", "https://", "http://[invalid]"]) {
  test(`rejects malformed URL: ${url}`, async () => {
    expectFailure(await run([url]), /Invalid URL/);
  });
}

test("rejects protocols other than HTTP(S)", async () => {
  expectFailure(await run(["file:///etc/hosts"]), /Unsupported URL protocol/);
});

test("rejects embedded credentials", async () => {
  expectFailure(await run(["http://user:secret@localhost/"]), /username or password/);
});

for (const status of [401, 403, 404, 429, 500, 503]) {
  test(`reports HTTP ${status} without waiting for its body`, async () => {
    expectFailure(await run([`${baseUrl}/status/${status}`]), new RegExp(`HTTP request failed: ${status}`));
  });
}

test("reports a redirect loop", async () => {
  expectFailure(await run([`${baseUrl}/redirect`]), /Too many HTTP redirects/);
});

test("does not count a partially downloaded response as success", async () => {
  expectFailure(await run([`${baseUrl}/broken-body`]), /Connection closed|Connection was reset|incomplete/);
});

test("reports invalid compressed response data", async () => {
  expectFailure(await run([`${baseUrl}/bad-gzip`]), /Could not read the full response body/);
});

// Только в дочернем тестовом процессе ускоряем реальный AbortSignal.timeout.
const shortTimeout = `
  const original = AbortSignal.timeout.bind(AbortSignal);
  AbortSignal.timeout = () => original(200);
`;
test("creates a fresh deadline for every request", async () => {
  sequenceStats = { requests: 0, active: 0, maxActive: 0, completed: 0 };
  const result = await run([`${baseUrl}/sequence`], shortTimeout);
  assert.equal(result.code, 0, result.stderr);
  assert.equal(readMetrics(result.stdout).bytes, 1055);
  assert.equal(sequenceStats.completed, 10);
});
for (const path of ["/slow-headers", "/slow-body"]) {
  test(`timeout covers both connection/headers and body: ${path}`, async () => {
    expectFailure(await run([`${baseUrl}${path}`], shortTimeout), /Request timed out/);
  });
}

test("Ctrl+C cancels an in-flight response with exit code 130", async () => {
  const interrupt = `
    const original = globalThis.fetch;
    globalThis.fetch = async (...args) => {
      const response = await original(...args);
      setTimeout(() => process.kill(process.pid, 'SIGINT'), 50);
      return response;
    };
  `;
  expectFailure(await run([`${baseUrl}/slow-body`], interrupt), /Request was cancelled/, 130);
});

// DNS/TLS и прочие системные ошибки моделируем без обращения к внешним серверам.
const failures = [
  ["ENOTFOUND", /DNS lookup failed/],
  ["EAI_AGAIN", /DNS lookup temporarily failed/],
  ["ECONNREFUSED", /Connection refused/],
  ["ENETUNREACH", /Network is unreachable/],
  ["EHOSTUNREACH", /Server is unreachable/],
  ["ECONNRESET", /Connection was reset/],
  ["EPIPE", /Connection closed/],
  ["ETIMEDOUT", /Network operation timed out/],
  ["UND_ERR_CONNECT_TIMEOUT", /Connection to the server timed out/],
  ["UND_ERR_HEADERS_TIMEOUT", /response headers/],
  ["UND_ERR_BODY_TIMEOUT", /response body data/],
  ["UND_ERR_RES_CONTENT_LENGTH_MISMATCH", /size does not match Content-Length/],
  ["UND_ERR_HEADERS_OVERFLOW", /headers that are too large/],
  ["ERR_SSL_WRONG_VERSION_NUMBER", /TLS connection failed/],
  ["DEPTH_ZERO_SELF_SIGNED_CERT", /self-signed/],
  ["SELF_SIGNED_CERT_IN_CHAIN", /self-signed/],
  ["UNABLE_TO_VERIFY_LEAF_SIGNATURE", /could not be verified/],
  ["UNABLE_TO_GET_ISSUER_CERT_LOCALLY", /issuer is not trusted/],
  ["CERT_HAS_EXPIRED", /TLS certificate or handshake/],
  ["ERR_TLS_CERT_ALTNAME_INVALID", /TLS certificate or handshake/],
  ["UNEXPECTED_TEST_ERROR", /Request failed unexpectedly/],
];

for (const [code, message] of failures) {
  test(`classifies wrapped network error ${code}`, async () => {
    const preload = `
      globalThis.fetch = async () => {
        const cause = Object.assign(new Error('fixture'), { code: ${JSON.stringify(code)} });
        throw new TypeError('fetch failed', { cause });
      };
    `;
    expectFailure(await run([`${baseUrl}/ok`], preload), message);
  });
}

test("reports ArrayBuffer size limits", async () => {
  const preload = `
    globalThis.fetch = async () => ({
      ok: true,
      arrayBuffer: async () => { throw new RangeError('fixture'); }
    });
  `;
  expectFailure(await run([`${baseUrl}/ok`], preload), /too large to store/);
});
