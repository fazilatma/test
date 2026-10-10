import { afterEach, describe, expect, it, vi } from "vitest";
import worker, { validateProxyTarget } from "../src/index";

afterEach(() => vi.unstubAllGlobals());

describe("proxy destination validation", () => {
  const allowlist = "example.com,*.docs.example.org,198.51.100.44";

  it("accepts an exact allowlisted HTTPS hostname", () => {
    const result = validateProxyTarget("https://example.com/reference?q=worker", allowlist);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.url.hostname).toBe("example.com");
  });

  it("matches wildcard subdomains but not the base domain", () => {
    expect(validateProxyTarget("https://api.docs.example.org/v1", allowlist).ok).toBe(true);
    expect(validateProxyTarget("https://docs.example.org/v1", allowlist).ok).toBe(false);
  });

  it("rejects hosts outside the operator allowlist", () => {
    const result = validateProxyTarget("https://not-example.com/", allowlist);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain("فهرست مجاز");
  });

  it.each([
    "http://localhost/admin",
    "https://app.local/",
    "http://127.0.0.1:80/",
    "http://169.254.169.254/latest/meta-data/",
    "http://10.2.3.4/",
    "http://192.0.2.1/",
    "https://[::1]/",
  ])("rejects private/local destination %s", (url) => {
    expect(validateProxyTarget(url, "localhost,*.local,127.0.0.1,169.254.169.254,10.2.3.4,192.0.2.1,[::1]").ok).toBe(false);
  });

  it("rejects embedded credentials, unsupported schemes, and nonstandard ports", () => {
    expect(validateProxyTarget("https://user:pass@example.com/", allowlist).ok).toBe(false);
    expect(validateProxyTarget("file:///etc/passwd", allowlist).ok).toBe(false);
    expect(validateProxyTarget("https://example.com:8443/", allowlist).ok).toBe(false);
  });

  it("fails closed when the allowlist is empty", () => {
    const result = validateProxyTarget("https://example.com/", "");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain("پیکربندی نشده");
  });
});

describe("Worker control endpoints", () => {
  it("returns a lightweight health response", async () => {
    const response = await worker.fetch(new Request("https://sepehr.example/healthz"), {} as never);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ ok: true, service: "sepehr-worker-browser" });
  });

  it("reports auth/proxy setup without disclosing secrets", async () => {
    const response = await worker.fetch(new Request("https://sepehr.example/api/session"), {
      AUTH_REQUIRED: "true",
      PROXY_ALLOWED_HOSTS: "example.com",
      SESSION_SECRET: "",
      ASSETS: { fetch: async () => new Response("unused") },
    } as never);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      authRequired: true,
      authConfigured: false,
      authenticated: false,
      proxyConfigured: true,
      ready: false,
    });
  });

  it("requires an explicit Google account allowlist before enabling OAuth", async () => {
    const response = await worker.fetch(new Request("https://sepehr.example/auth/google"), {
      AUTH_REQUIRED: "true",
      GOOGLE_CLIENT_ID: "client-id",
      GOOGLE_CLIENT_SECRET: "client-secret",
      SESSION_SECRET: "0123456789abcdef0123456789abcdef",
      GOOGLE_ALLOWED_EMAILS: "",
      GOOGLE_ALLOWED_DOMAIN: "",
      ASSETS: { fetch: async () => new Response("unused") },
    } as never);
    expect(response.status).toBe(503);
    expect(await response.text()).toContain("برای جلوگیری از ثبت‌نام عمومی");
  });

  it("does not allow unauthenticated proxy calls when Google auth is required", async () => {
    const response = await worker.fetch(new Request("https://sepehr.example/proxy?url=https%3A%2F%2Fexample.com"), {
      AUTH_REQUIRED: "true",
      PROXY_ALLOWED_HOSTS: "example.com",
      SESSION_SECRET: "",
      ASSETS: { fetch: async () => new Response("unused") },
    } as never);
    expect(response.status).toBe(503);
    expect(await response.text()).toContain("ورود امن پیکربندی نشده است");
  });

  it("fails closed when guest mode has no destination allowlist", async () => {
    const response = await worker.fetch(new Request("https://sepehr.example/proxy?url=https%3A%2F%2Fexample.com"), {
      AUTH_REQUIRED: "false",
      PROXY_ALLOWED_HOSTS: "",
      ASSETS: { fetch: async () => new Response("unused") },
    } as never);
    expect(response.status).toBe(503);
    expect(await response.text()).toContain("فهرست PROXY_ALLOWED_HOSTS");
  });
});

describe("HTTP method forwarding", () => {
  it.each(["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"])("forwards %s without leaking app cookies or unscoped authorization", async (method) => {
    let capturedBody = "";
    let capturedInit: RequestInit | undefined;
    const mockFetch = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      capturedInit = init;
      if (init?.body) capturedBody = await new Response(init.body).text();
      return new Response(method === "HEAD" ? null : "upstream response", {
        status: 200,
        headers: { "Content-Type": "text/plain" },
      });
    });
    vi.stubGlobal("fetch", mockFetch);

    const body = ["GET", "HEAD"].includes(method) ? undefined : "request payload";
    const request = new Request("https://sepehr.example/proxy?url=https%3A%2F%2Fexample.com%2Fapi", {
      method,
      body,
      headers: { Cookie: "sepehr_session=private", Authorization: "Bearer private" },
    });
    const response = await worker.fetch(request, {
      AUTH_REQUIRED: "false",
      PROXY_ALLOWED_HOSTS: "example.com",
      ASSETS: { fetch: async () => new Response("unused") },
    } as never);

    expect(response.status).toBe(200);
    expect(mockFetch).toHaveBeenCalledOnce();
    expect(capturedInit?.method).toBe(method);
    const forwardedHeaders = new Headers(capturedInit?.headers);
    expect(forwardedHeaders.has("cookie")).toBe(false);
    expect(forwardedHeaders.has("authorization")).toBe(false);
    if (body) expect(capturedBody).toBe(body);
  });

  it.each([
    ["https://example.com", true],
    ["https://other.example", false],
    ["http://example.com", false],
  ])("only forwards Authorization when bound to the exact request origin %s", async (boundOrigin, shouldForward) => {
    let capturedHeaders = new Headers();
    const mockFetch = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      capturedHeaders = new Headers(init?.headers);
      return new Response("ok", { headers: { "Content-Type": "text/plain" } });
    });
    vi.stubGlobal("fetch", mockFetch);
    const request = new Request("https://sepehr.example/proxy?url=https%3A%2F%2Fexample.com%2Fapi", {
      headers: {
        Authorization: "Bearer destination-token",
        "X-Proxy-Authorization-Origin": boundOrigin,
      },
    });
    const response = await worker.fetch(request, {
      AUTH_REQUIRED: "false",
      PROXY_ALLOWED_HOSTS: "example.com",
      ASSETS: { fetch: async () => new Response("unused") },
    } as never);

    expect(response.status).toBe(200);
    expect(capturedHeaders.has("authorization")).toBe(shouldForward);
    expect(capturedHeaders.has("x-proxy-authorization-origin")).toBe(false);
  });
});
