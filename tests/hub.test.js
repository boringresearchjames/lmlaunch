import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { startServer, stopServer, testBase, TEST_TOKEN } from "./helpers/server.js";

const auth = { Authorization: `Bearer ${TEST_TOKEN}` };
const jsonHeaders = { ...auth, "Content-Type": "application/json" };

beforeAll(startServer);
afterAll(stopServer);

// ---------------------------------------------------------------------------
// POST /v1/hub/download — input validation
// ---------------------------------------------------------------------------

describe("POST /v1/hub/download validation", () => {
  it("returns 400 when repoId and filename are both missing", async () => {
    const res = await fetch(`${testBase}/v1/hub/download`, {
      method: "POST",
      headers: jsonHeaders,
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toMatch(/repoId/i);
  });

  it("returns 400 when filename is missing", async () => {
    const res = await fetch(`${testBase}/v1/hub/download`, {
      method: "POST",
      headers: jsonHeaders,
      body: JSON.stringify({ repoId: "bartowski/Llama-3.2-1B-Instruct-GGUF" }),
    });
    expect(res.status).toBe(400);
  });

  it("returns 400 for an invalid repoId format (no slash)", async () => {
    const res = await fetch(`${testBase}/v1/hub/download`, {
      method: "POST",
      headers: jsonHeaders,
      body: JSON.stringify({ repoId: "invalidrepo", filename: "model.gguf" }),
    });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toMatch(/invalid repoId/i);
  });

  it("returns 400 for a repoId with path traversal characters", async () => {
    const res = await fetch(`${testBase}/v1/hub/download`, {
      method: "POST",
      headers: jsonHeaders,
      body: JSON.stringify({ repoId: "../etc/passwd", filename: "model.gguf" }),
    });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toMatch(/invalid repoId/i);
  });

  it("returns 400 when filename is not a .gguf file", async () => {
    const res = await fetch(`${testBase}/v1/hub/download`, {
      method: "POST",
      headers: jsonHeaders,
      body: JSON.stringify({ repoId: "bartowski/Llama-3.2-1B-Instruct-GGUF", filename: "model.bin" }),
    });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toMatch(/gguf/i);
  });

  it("returns 400 when filename contains a path traversal sequence", async () => {
    const res = await fetch(`${testBase}/v1/hub/download`, {
      method: "POST",
      headers: jsonHeaders,
      body: JSON.stringify({ repoId: "bartowski/Llama-3.2-1B-Instruct-GGUF", filename: "../etc/passwd.gguf" }),
    });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toMatch(/invalid filename/i);
  });
});

// ---------------------------------------------------------------------------
// GET /v1/hub/downloads
// ---------------------------------------------------------------------------

describe("GET /v1/hub/downloads", () => {
  it("returns 200 with an empty array on fresh state", async () => {
    const res = await fetch(`${testBase}/v1/hub/downloads`, { headers: auth });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(Array.isArray(body.data)).toBe(true);
  });
});
