type SessionUser = {
  sub: string;
  email: string;
  name?: string;
  picture?: string;
  exp: number;
  typ: "session";
};

type ProxyCapability = {
  sub: string;
  exp: number;
  typ: "proxy";
};

type OAuthState = {
  state: string;
  nonce: string;
  exp: number;
  typ: "oauth-state";
};

type ProxyPrincipal = Pick<SessionUser, "sub">;

type Env = {
  ASSETS: {
    fetch(request: Request): Promise<Response>;
  };
  GOOGLE_CLIENT_ID?: string;
  GOOGLE_CLIENT_SECRET?: string;
  GOOGLE_ALLOWED_EMAILS?: string;
  GOOGLE_ALLOWED_DOMAIN?: string;
  SESSION_SECRET?: string;
  APP_BASE_URL?: string;
  PROXY_ALLOWED_HOSTS?: string;
  PROXY_MAX_BODY_BYTES?: string;
  PROXY_TIMEOUT_MS?: string;
  AUTH_REQUIRED?: string;
};

const SESSION_COOKIE = "sepehr_session";
const OAUTH_COOKIE = "sepehr_oauth_state";
const SESSION_TTL_SECONDS = 7 * 24 * 60 * 60;
const OAUTH_STATE_TTL_SECONDS = 10 * 60;
const PROXY_CAP_TTL_SECONDS = 15 * 60;
const DEFAULT_MAX_BODY_BYTES = 10 * 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 25_000;
const MAX_TARGET_LENGTH = 8_192;
const MAX_CSS_REWRITE_BYTES = 1_500_000;
const encoder = new TextEncoder();

const HOP_BY_HOP_HEADERS = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
  "host",
  "content-length",
  "accept-encoding",
  "cookie",
  "set-cookie",
  "set-cookie2",
  "cf-connecting-ip",
  "cf-ipcountry",
  "cf-ray",
  "cf-visitor",
  "x-forwarded-for",
  "x-forwarded-host",
  "x-forwarded-proto",
  "x-real-ip",
]);

const STRIPPED_RESPONSE_HEADERS = [
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
  "set-cookie",
  "set-cookie2",
  "content-security-policy",
  "content-security-policy-report-only",
  "x-frame-options",
  "cross-origin-opener-policy",
  "cross-origin-embedder-policy",
  "cross-origin-resource-policy",
  "strict-transport-security",
];

function json(data: unknown, status = 200, headers = new Headers()): Response {
  headers.set("Content-Type", "application/json; charset=utf-8");
  headers.set("Cache-Control", "no-store");
  headers.set("X-Content-Type-Options", "nosniff");
  return new Response(JSON.stringify(data), { status, headers });
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (char) => {
    const entities: Record<string, string> = {
      "&": "&amp;",
      "<": "&lt;",
      ">": "&gt;",
      '"': "&quot;",
      "'": "&#39;",
    };
    return entities[char] ?? char;
  });
}

function errorPage(title: string, detail: string, status: number): Response {
  const safeTitle = escapeHtml(title);
  const safeDetail = escapeHtml(detail);
  const html = `<!doctype html><html lang="fa" dir="rtl"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${safeTitle}</title><style>body{margin:0;min-height:100vh;display:grid;place-items:center;background:#0b1020;color:#edf2ff;font:16px/1.8 system-ui,sans-serif}.card{max-width:620px;margin:24px;padding:32px;border:1px solid #29324d;border-radius:20px;background:#121a2d;box-shadow:0 24px 80px #0006}h1{font-size:24px;margin:0 0 12px}.muted{color:#a6b1ca}.badge{display:inline-flex;padding:4px 10px;border-radius:99px;background:#261d32;color:#f4bbd7;font-size:12px}</style><main class="card"><span class="badge">سپهر · دروازهٔ امن</span><h1>${safeTitle}</h1><p class="muted">${safeDetail}</p><p class="muted">برای ادامه، تنظیمات ورود و فهرست دامنه‌های مجاز را بررسی کنید.</p></main></html>`;
  return new Response(html, {
    status,
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
      "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; frame-ancestors 'self'",
      "Referrer-Policy": "no-referrer",
    },
  });
}

function base64UrlEncode(bytes: Uint8Array): string {
  let binary = "";
  for (let index = 0; index < bytes.length; index += 1) {
    binary += String.fromCharCode(bytes[index]!);
  }
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function base64UrlDecode(value: string): Uint8Array {
  const normalized = value.replace(/-/g, "+").replace(/_/g, "/");
  const padded = normalized + "=".repeat((4 - (normalized.length % 4)) % 4);
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}

function hasStrongSessionSecret(env: Env): boolean {
  return (env.SESSION_SECRET?.trim().length ?? 0) >= 32;
}

async function signingKey(env: Env): Promise<CryptoKey> {
  const secret = env.SESSION_SECRET?.trim();
  if (!secret || encoder.encode(secret).length < 32) {
    throw new Error("SESSION_SECRET must be at least 32 bytes.");
  }
  return crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign", "verify"],
  );
}

async function signPayload(payload: object, env: Env): Promise<string> {
  const encodedPayload = base64UrlEncode(encoder.encode(JSON.stringify(payload)));
  const signature = await crypto.subtle.sign(
    "HMAC",
    await signingKey(env),
    encoder.encode(encodedPayload),
  );
  return `${encodedPayload}.${base64UrlEncode(new Uint8Array(signature))}`;
}

async function verifyPayload<T extends { exp: number; typ: string }>(
  token: string | null,
  expectedType: T["typ"],
  env: Env,
): Promise<T | null> {
  if (!token || token.length > 4_096 || !hasStrongSessionSecret(env)) return null;
  const parts = token.split(".");
  if (parts.length !== 2) return null;
  try {
    const decodedSignature = base64UrlDecode(parts[1]!);
    const signature = new Uint8Array(new ArrayBuffer(decodedSignature.byteLength));
    signature.set(decodedSignature);
    const valid = await crypto.subtle.verify(
      "HMAC",
      await signingKey(env),
      signature,
      encoder.encode(parts[0]!),
    );
    if (!valid) return null;
    const payload = JSON.parse(new TextDecoder().decode(base64UrlDecode(parts[0]!))) as T;
    if (payload.typ !== expectedType || !Number.isFinite(payload.exp) || payload.exp <= Date.now() / 1000) {
      return null;
    }
    return payload;
  } catch {
    return null;
  }
}

function readCookie(request: Request, name: string): string | null {
  const cookieHeader = request.headers.get("Cookie");
  if (!cookieHeader) return null;
  for (const cookie of cookieHeader.split(";")) {
    const separator = cookie.indexOf("=");
    if (separator < 0) continue;
    if (cookie.slice(0, separator).trim() === name) {
      return cookie.slice(separator + 1).trim();
    }
  }
  return null;
}

function cookieValue(name: string, value: string, request: Request, maxAge: number): string {
  const secure = new URL(request.url).protocol === "https:" ? "; Secure" : "";
  return `${name}=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${secure}`;
}

function clearCookie(name: string, request: Request): string {
  return cookieValue(name, "", request, 0);
}

function authRequired(env: Env): boolean {
  const setting = env.AUTH_REQUIRED?.trim().toLowerCase();
  return setting !== "false" && setting !== "0" && setting !== "no";
}

function googleAccessPolicyConfigured(env: Env): boolean {
  const emails = (env.GOOGLE_ALLOWED_EMAILS ?? "").split(",").map((value) => value.trim()).filter(Boolean);
  const domains = (env.GOOGLE_ALLOWED_DOMAIN ?? "").split(",").map((value) => value.trim()).filter(Boolean);
  return emails.length > 0 || domains.length > 0;
}

function googleConfigured(env: Env): boolean {
  return Boolean(
    env.GOOGLE_CLIENT_ID?.trim() &&
      env.GOOGLE_CLIENT_SECRET?.trim() &&
      hasStrongSessionSecret(env) &&
      googleAccessPolicyConfigured(env),
  );
}

async function readSession(request: Request, env: Env): Promise<SessionUser | null> {
  const session = await verifyPayload<SessionUser>(readCookie(request, SESSION_COOKIE), "session", env);
  if (!session || typeof session.sub !== "string" || typeof session.email !== "string") return null;
  return session;
}

function allowedHostPatterns(env: Env): string[] {
  return (env.PROXY_ALLOWED_HOSTS ?? "")
    .split(",")
    .map((pattern) => pattern.trim().toLowerCase().replace(/\.$/, ""))
    .filter(Boolean);
}

function isHostOnAllowlist(host: string, configuredPatterns: string[]): boolean {
  const normalizedHost = host.toLowerCase().replace(/\.$/, "");
  return configuredPatterns.some((configured) => {
    const pattern = configured.replace(/\.$/, "");
    if (pattern.startsWith("*.")) {
      const suffix = pattern.slice(2);
      return normalizedHost !== suffix && normalizedHost.endsWith(`.${suffix}`);
    }
    return normalizedHost === pattern;
  });
}

function isPrivateOrLocalHost(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, "").replace(/\.$/, "");
  if (
    host === "localhost" ||
    host.endsWith(".localhost") ||
    host.endsWith(".local") ||
    host.endsWith(".internal") ||
    host.endsWith(".lan") ||
    host === "metadata" ||
    host === "metadata.google.internal" ||
    host.endsWith(".home.arpa")
  ) {
    return true;
  }

  // IPv6 literals are deliberately disabled. Correctly classifying all special-use
  // ranges is error-prone, while domain allowlists cover normal public sites.
  if (host.includes(":")) return true;

  if (!/^\d{1,3}(?:\.\d{1,3}){3}$/.test(host)) return false;
  const octets = host.split(".").map(Number);
  if (octets.some((octet) => octet < 0 || octet > 255)) return true;
  const [a, b, c] = octets as [number, number, number, number];
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    a >= 224 ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && (b === 168 || b === 0 || (b === 2 && c === 0))) ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 198 && (b === 18 || b === 19 || (b === 51 && c === 100))) ||
    (a === 203 && b === 0 && c === 113)
  );
}

export type TargetValidation = { ok: true; url: URL } | { ok: false; reason: string };

export function validateProxyTarget(raw: string, allowedHosts: string | undefined): TargetValidation {
  if (!raw || raw.length > MAX_TARGET_LENGTH) {
    return { ok: false, reason: "نشانی مقصد خالی یا بیش از حد طولانی است." };
  }

  let target: URL;
  try {
    target = new URL(raw);
  } catch {
    return { ok: false, reason: "نشانی مقصد معتبر نیست؛ نشانی کامل http یا https وارد کنید." };
  }

  if (target.protocol !== "https:" && target.protocol !== "http:") {
    return { ok: false, reason: "فقط مقصدهای HTTP و HTTPS پشتیبانی می‌شوند." };
  }
  if (target.username || target.password) {
    return { ok: false, reason: "قرار دادن نام کاربری یا گذرواژه در نشانی مقصد مجاز نیست." };
  }
  if ((target.protocol === "https:" && target.port && target.port !== "443") || (target.protocol === "http:" && target.port && target.port !== "80")) {
    return { ok: false, reason: "برای جلوگیری از دسترسی ناخواسته، فقط درگاه‌های استاندارد 80 و 443 مجاز هستند." };
  }
  if (isPrivateOrLocalHost(target.hostname)) {
    return { ok: false, reason: "دسترسی به نشانی‌های محلی، خصوصی و IPهای IPv6 مسدود است." };
  }

  const patterns = (allowedHosts ?? "")
    .split(",")
    .map((pattern) => pattern.trim().toLowerCase().replace(/\.$/, ""))
    .filter(Boolean);
  if (patterns.length === 0) {
    return { ok: false, reason: "فهرست PROXY_ALLOWED_HOSTS هنوز پیکربندی نشده است." };
  }
  if (!isHostOnAllowlist(target.hostname, patterns)) {
    return { ok: false, reason: `دامنهٔ ${target.hostname} در فهرست مجاز این سرویس نیست.` };
  }
  return { ok: true, url: target };
}

function authConfigMessage(env: Env): string {
  if (!hasStrongSessionSecret(env)) return "برای فعال‌سازی نشست امن، یک SESSION_SECRET تصادفی با حداقل ۳۲ بایت تنظیم کنید.";
  if (!env.GOOGLE_CLIENT_ID?.trim() || !env.GOOGLE_CLIENT_SECRET?.trim()) {
    return "ورود گوگل هنوز پیکربندی نشده است؛ شناسه و کلید محرمانهٔ OAuth را در Cloudflare تنظیم کنید.";
  }
  if (!googleAccessPolicyConfigured(env)) {
    return "برای جلوگیری از ثبت‌نام عمومی، GOOGLE_ALLOWED_EMAILS یا GOOGLE_ALLOWED_DOMAIN را تنظیم کنید.";
  }
  return "";
}

async function principalForProxy(
  request: Request,
  proxyUrl: URL,
  env: Env,
): Promise<{ principal: ProxyPrincipal | null; error: Response | null }> {
  const signedIn = await readSession(request, env);
  if (signedIn) return { principal: { sub: signedIn.sub }, error: null };

  const capability = await verifyPayload<ProxyCapability>(proxyUrl.searchParams.get("cap"), "proxy", env);
  if (capability && typeof capability.sub === "string") {
    return { principal: { sub: capability.sub }, error: null };
  }

  if (!authRequired(env)) return { principal: null, error: null };
  if (!googleConfigured(env)) {
    return {
      principal: null,
      error: errorPage("ورود امن پیکربندی نشده است", authConfigMessage(env), 503),
    };
  }
  return {
    principal: null,
    error: errorPage("ورود لازم است", "برای استفاده از پروکسی، ابتدا از صفحهٔ اصلی با حساب گوگل وارد شوید.", 401),
  };
}

async function mintProxyCapability(principal: ProxyPrincipal | null, env: Env): Promise<string | null> {
  if (!principal || !authRequired(env)) return null;
  return signPayload(
    { sub: principal.sub, exp: Math.floor(Date.now() / 1000) + PROXY_CAP_TTL_SECONDS, typ: "proxy" } satisfies ProxyCapability,
    env,
  );
}

function proxyPath(target: URL, capability: string | null): string {
  const query = new URLSearchParams({ url: target.href });
  if (capability) query.set("cap", capability);
  return `/proxy?${query.toString()}`;
}

function withCors(headers: Headers, request: Request): Headers {
  const origin = request.headers.get("Origin");
  if (origin === "null" || origin === new URL(request.url).origin) {
    headers.set("Access-Control-Allow-Origin", origin);
    headers.set("Access-Control-Allow-Credentials", "true");
    headers.append("Vary", "Origin");
  }
  headers.set(
    "Access-Control-Expose-Headers",
    "Content-Type, Content-Length, Content-Range, Accept-Ranges, Content-Disposition, ETag, Last-Modified, Location, Cache-Control",
  );
  return headers;
}

function safeRequestedCorsHeaders(request: Request): string {
  const requested = request.headers.get("Access-Control-Request-Headers") ?? "";
  const forbidden = new Set(["cookie", "set-cookie", "proxy-authorization"]);
  return requested
    .split(",")
    .map((value) => value.trim().toLowerCase())
    .filter((value) => value && !forbidden.has(value) && !value.startsWith("cf-") && !value.startsWith("x-forwarded-"))
    .join(", ");
}

function corsPreflight(request: Request): Response {
  const requestedMethod = request.headers.get("Access-Control-Request-Method")?.toUpperCase();
  if (requestedMethod && (!/^[!#$%&'*+.^_`|~0-9A-Z-]+$/.test(requestedMethod) || ["CONNECT", "TRACE", "TRACK"].includes(requestedMethod))) {
    return errorPage("روش درخواست پشتیبانی نمی‌شود", "روش درخواست در این پراکسی قابل استفاده نیست.", 405);
  }
  const headers = new Headers({
    "Access-Control-Allow-Methods": "GET, HEAD, POST, PUT, PATCH, DELETE, OPTIONS",
    "Access-Control-Max-Age": "600",
    "Cache-Control": "no-store",
    "Vary": "Origin, Access-Control-Request-Method, Access-Control-Request-Headers",
  });
  if (requestedMethod) headers.set("Access-Control-Allow-Methods", `${requestedMethod}, GET, HEAD, POST, PUT, PATCH, DELETE, OPTIONS`);
  const allowedHeaders = safeRequestedCorsHeaders(request);
  if (allowedHeaders) headers.set("Access-Control-Allow-Headers", allowedHeaders);
  withCors(headers, request);
  return new Response(null, { status: 204, headers });
}

function maxBodyBytes(env: Env): number {
  const configured = Number(env.PROXY_MAX_BODY_BYTES);
  return Number.isFinite(configured) && configured > 0 ? Math.min(configured, 100 * 1024 * 1024) : DEFAULT_MAX_BODY_BYTES;
}

class BodyLimitError extends Error {
  constructor() {
    super("The request body is larger than the configured limit.");
    this.name = "BodyLimitError";
  }
}

function limitedBody(body: ReadableStream<Uint8Array> | null, maxBytes: number): ReadableStream<Uint8Array> | null {
  if (!body) return null;
  let seen = 0;
  return body.pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        seen += chunk.byteLength;
        if (seen > maxBytes) throw new BodyLimitError();
        controller.enqueue(chunk);
      },
    }),
  );
}

function cleanRequestHeaders(request: Request, appOrigin: string, target: URL): Headers {
  const headers = new Headers(request.headers);
  for (const name of HOP_BY_HOP_HEADERS) headers.delete(name);
  for (const name of [...headers.keys()]) {
    if (name.toLowerCase().startsWith("cf-") || name.toLowerCase().startsWith("x-forwarded-")) headers.delete(name);
  }
  headers.delete("origin");
  headers.delete("referer");
  const authorizationOrigin = request.headers.get("X-Proxy-Authorization-Origin");
  headers.delete("x-proxy-authorization-origin");
  let mayForwardAuthorization = false;
  if (authorizationOrigin) {
    try {
      mayForwardAuthorization = target.protocol === "https:" && new URL(authorizationOrigin).origin === target.origin;
    } catch {
      mayForwardAuthorization = false;
    }
  }
  if (!mayForwardAuthorization) headers.delete("authorization");
  // The app session cookie is never forwarded to an upstream destination.
  headers.delete("cookie");

  const sourceOrigin = request.headers.get("Origin");
  if (sourceOrigin && sourceOrigin !== "null" && sourceOrigin !== appOrigin) {
    headers.set("Origin", sourceOrigin);
  }
  const referer = request.headers.get("Referer");
  if (referer) {
    try {
      if (new URL(referer).origin !== appOrigin) headers.set("Referer", referer);
    } catch {
      // Drop malformed referrers rather than forwarding untrusted header text.
    }
  }
  // Authorization is forwarded only when explicitly bound to this exact target origin;
  // this prevents credentials from following a redirect to a different origin.
  return headers;
}

function rewriteCss(css: string, base: URL, capability: string | null): string {
  const rewrite = (value: string): string => {
    const trimmed = value.trim();
    if (!trimmed || /^(?:data:|blob:|javascript:|mailto:|tel:|#)/i.test(trimmed)) return value;
    try {
      const resolved = new URL(trimmed, base);
      if (resolved.protocol !== "http:" && resolved.protocol !== "https:") return value;
      return proxyPath(resolved, capability);
    } catch {
      return value;
    }
  };

  let result = css.replace(/url\(\s*(['"]?)(.*?)\1\s*\)/gi, (_match, quote: string, raw: string) => {
    const rewritten = rewrite(raw);
    return `url(${quote}${rewritten}${quote})`;
  });
  result = result.replace(/(@import\s+)(['"])([^'"]+)\2/gi, (_match, prefix: string, quote: string, raw: string) => {
    return `${prefix}${quote}${rewrite(raw)}${quote}`;
  });
  return result;
}

function rewriteSrcset(value: string, base: URL, capability: string | null): string {
  if (value.trim().toLowerCase().startsWith("data:")) return value;
  return value.replace(/(^|,\s*)([^\s,]+)(?=\s|,|$)/g, (match, prefix: string, rawUrl: string) => {
    if (/^(?:data:|blob:|#)/i.test(rawUrl)) return match;
    try {
      const resolved = new URL(rawUrl, base);
      if (resolved.protocol !== "http:" && resolved.protocol !== "https:") return match;
      return `${prefix}${proxyPath(resolved, capability)}`;
    } catch {
      return match;
    }
  });
}

function safeInlineJson(value: string): string {
  return JSON.stringify(value).replace(/</g, "\\u003c").replace(/\u2028/g, "\\u2028").replace(/\u2029/g, "\\u2029");
}

function browserBridge(target: URL, capability: string | null): string {
  const targetLiteral = safeInlineJson(target.href);
  const capabilityLiteral = safeInlineJson(capability ?? "");
  return `<script data-sepehr-bridge>(function(){"use strict";var base=new URL(${targetLiteral});var cap=${capabilityLiteral};function mapped(input){try{var u=new URL(String(input),base);if(u.protocol!=="http:"&&u.protocol!=="https:")return null;var q=new URLSearchParams({url:u.href});if(cap)q.set("cap",cap);return "/proxy?"+q.toString()}catch(_){return null}}function send(type,url,newTab){try{parent.postMessage({__sepehr:true,type:type,url:url,newTab:!!newTab},"*")}catch(_){}}var nativeFetch=window.fetch.bind(window);window.fetch=function(input,init){var raw=input instanceof Request?input.url:input;var dest=mapped(raw);if(!dest)return nativeFetch(input,init);try{var options=Object.assign({},init||{},{credentials:"include",mode:"cors"});if(input instanceof Request){var copied=new Request(input,options);var copiedHeaders=new Headers(copied.headers);if(copiedHeaders.has("Authorization")){try{copiedHeaders.set("X-Proxy-Authorization-Origin",new URL(String(raw),base).origin)}catch(_){}}copied=new Request(copied,{headers:copiedHeaders});return nativeFetch(new Request(dest,copied))}var headers=new Headers(options.headers||undefined);if(headers.has("Authorization")){try{headers.set("X-Proxy-Authorization-Origin",new URL(String(raw),base).origin)}catch(_){}}options.headers=headers;return nativeFetch(dest,options)}catch(_){return nativeFetch(dest,Object.assign({},init||{},{credentials:"include",mode:"cors"}))}};var open=XMLHttpRequest.prototype.open;XMLHttpRequest.prototype.open=function(method,url){var args=Array.prototype.slice.call(arguments,2);this.__sepehrRemoteUrl=String(url);var dest=mapped(url);return open.apply(this,[method,dest||url].concat(args))};var setHeader=XMLHttpRequest.prototype.setRequestHeader;XMLHttpRequest.prototype.setRequestHeader=function(name,value){var result=setHeader.call(this,name,value);if(String(name).toLowerCase()==="authorization"&&this.__sepehrRemoteUrl){try{setHeader.call(this,"X-Proxy-Authorization-Origin",new URL(this.__sepehrRemoteUrl,base).origin)}catch(_){}}return result};var sendBody=XMLHttpRequest.prototype.send;XMLHttpRequest.prototype.send=function(){try{this.withCredentials=true}catch(_){}return sendBody.apply(this,arguments)};var NativeWebSocket=window.WebSocket;var RoutedWebSocket=function(url,protocols){var raw=url instanceof URL?url.href:String(url);var remote;try{remote=new URL(raw,base)}catch(_){return protocols===undefined?new NativeWebSocket(raw):new NativeWebSocket(raw,protocols)}if(remote.protocol==="http:")remote.protocol="ws:";else if(remote.protocol==="https:")remote.protocol="wss:";if(remote.protocol!=="ws:"&&remote.protocol!=="wss:")return protocols===undefined?new NativeWebSocket(raw):new NativeWebSocket(raw,protocols);remote.protocol=remote.protocol==="wss:"?"https:":"http:";var endpoint=new URL("/proxy",window.location.href);endpoint.protocol=window.location.protocol==="https:"?"wss:":"ws:";endpoint.searchParams.set("url",remote.href);if(cap)endpoint.searchParams.set("cap",cap);return protocols===undefined?new NativeWebSocket(endpoint.href):new NativeWebSocket(endpoint.href,protocols)};RoutedWebSocket.prototype=NativeWebSocket.prototype;Object.setPrototypeOf(RoutedWebSocket,NativeWebSocket);window.WebSocket=RoutedWebSocket;document.addEventListener("click",function(event){var node=event.target instanceof Element?event.target:null;var link=node&&node.closest("a[href]");if(!link||link.hasAttribute("download"))return;var raw=link.getAttribute("data-sepehr-original-href")||link.getAttribute("href");if(!raw||raw.charAt(0)==="#"||/^(?:mailto:|tel:|javascript:|data:)/i.test(raw))return;var dest;try{dest=new URL(raw,base).href}catch(_){return}event.preventDefault();event.stopPropagation();send("navigate",dest,link.getAttribute("target")==="_blank"||event.ctrlKey||event.metaKey||event.shiftKey)} ,true);window.open=function(url){if(url){try{send("navigate",new URL(url,base).href,true)}catch(_){}}return null};function title(){send("title",document.title,false)}document.addEventListener("DOMContentLoaded",title,{once:true});new MutationObserver(title).observe(document.documentElement,{subtree:true,childList:true,characterData:true});window.addEventListener("pageshow",title);})();</script>`;
}

function rewriteHtml(response: Response, target: URL, capability: string | null): Response {
  const headers = new Headers(response.headers);
  headers.delete("content-length");
  headers.delete("content-encoding");
  headers.set("Cache-Control", "private, no-store");
  const script = browserBridge(target, capability);
  let injected = false;
  let documentBase = new URL(target.href);

  const rewriteAttribute = (element: Element, attribute: string): void => {
    const current = element.getAttribute(attribute);
    if (current === null || current === "") {
      if (attribute === "action") element.setAttribute(attribute, proxyPath(documentBase, capability));
      return;
    }
    const value = current.trim();
    if (/^(?:#|data:|blob:|javascript:|mailto:|tel:|about:)/i.test(value)) return;
    try {
      const resolved = new URL(value, documentBase);
      if (resolved.protocol !== "http:" && resolved.protocol !== "https:") return;
      element.setAttribute(attribute, proxyPath(resolved, capability));
    } catch {
      // Leave invalid attributes alone; the proxy endpoint rejects malformed targets.
    }
  };

  const rewriter = new HTMLRewriter()
    .on("base", {
      element(element) {
        const href = element.getAttribute("href");
        if (href) {
          try {
            documentBase = new URL(href, documentBase);
          } catch {
            // Ignore invalid <base> values.
          }
        }
        element.remove();
      },
    })
    .on("meta[http-equiv]", {
      element(element) {
        const value = element.getAttribute("http-equiv")?.toLowerCase();
        if (value === "refresh" || value === "content-security-policy") element.remove();
      },
    })
    .on("[href]", {
      element(element) {
        const href = element.getAttribute("href");
        if (element.tagName.toLowerCase() === "a" && href !== null) {
          element.setAttribute("data-sepehr-original-href", href);
        }
        rewriteAttribute(element, "href");
      },
    })
    .on("[src]", { element: (element) => rewriteAttribute(element, "src") })
    .on("[action]", { element: (element) => rewriteAttribute(element, "action") })
    .on("[formaction]", { element: (element) => rewriteAttribute(element, "formaction") })
    .on("[poster]", { element: (element) => rewriteAttribute(element, "poster") })
    .on("[data]", { element: (element) => rewriteAttribute(element, "data") })
    .on("[cite]", { element: (element) => rewriteAttribute(element, "cite") })
    .on("[background]", { element: (element) => rewriteAttribute(element, "background") })
    .on("[xlink\\:href]", { element: (element) => rewriteAttribute(element, "xlink:href") })
    .on("[srcset]", {
      element(element) {
        const value = element.getAttribute("srcset");
        if (value) element.setAttribute("srcset", rewriteSrcset(value, documentBase, capability));
      },
    })
    .on("[style]", {
      element(element) {
        const value = element.getAttribute("style");
        if (value) element.setAttribute("style", rewriteCss(value, documentBase, capability));
      },
    })
    .on("[srcdoc]", {
      element(element) {
        element.removeAttribute("srcdoc");
      },
    })
    .on("style", {
      text(textChunk) {
        if (textChunk.text) textChunk.replace(rewriteCss(textChunk.text, documentBase, capability));
      },
    })
    .on("head", {
      element(element) {
        if (!injected) {
          element.prepend(script, { html: true });
          injected = true;
        }
      },
    })
    .on("body", {
      element(element) {
        if (!injected) {
          element.prepend(script, { html: true });
          injected = true;
        }
      },
    });

  const transformed = rewriter.transform(response);
  return new Response(transformed.body, {
    status: transformed.status,
    statusText: transformed.statusText,
    headers,
  });
}

function proxyResponseHeaders(upstream: Response, request: Request): Headers {
  const headers = new Headers(upstream.headers);
  for (const name of STRIPPED_RESPONSE_HEADERS) headers.delete(name);
  headers.set("Cache-Control", "private, no-store");
  headers.set("X-Content-Type-Options", "nosniff");
  headers.set("Referrer-Policy", "no-referrer");
  return withCors(headers, request);
}

function appendFormQuery(proxyRequestUrl: URL, target: URL, method: string): URL {
  if (method.toUpperCase() !== "GET" && method.toUpperCase() !== "HEAD") return target;
  for (const [key, value] of proxyRequestUrl.searchParams.entries()) {
    if (key !== "url" && key !== "cap") target.searchParams.append(key, value);
  }
  return target;
}

function proxyTimeoutMs(env: Env): number {
  const configured = Number(env.PROXY_TIMEOUT_MS);
  return Number.isFinite(configured) && configured > 0 ? Math.min(configured, 60_000) : DEFAULT_TIMEOUT_MS;
}

async function handleWebSocketProxy(request: Request, target: URL, env: Env): Promise<Response> {
  const headers = cleanRequestHeaders(request, new URL(request.url).origin, target);
  headers.delete("sec-websocket-key");
  headers.delete("sec-websocket-version");
  headers.delete("sec-websocket-extensions");
  headers.set("Upgrade", "websocket");
  // The iframe sandbox presents an opaque Origin. The virtual page's WebSocket
  // connection is anonymous (no upstream cookies/auth), so use the destination origin.
  headers.set("Origin", target.origin);

  try {
    const upstream = await fetch(target.href, {
      method: "GET",
      headers,
      redirect: "manual",
      signal: AbortSignal.timeout(proxyTimeoutMs(env)),
    });
    if (upstream.status === 101 && upstream.webSocket) {
      const responseHeaders = new Headers();
      const protocol = upstream.headers.get("Sec-WebSocket-Protocol");
      if (protocol) responseHeaders.set("Sec-WebSocket-Protocol", protocol);
      return new Response(null, {
        status: 101,
        webSocket: upstream.webSocket,
        headers: responseHeaders,
      });
    }
    if (upstream.status >= 300 && upstream.status < 400) {
      return errorPage("اتصال WebSocket منتقل شد", "سرور WebSocket ریدایرکت داد؛ اتصال مجدد با نشانی نهایی را امتحان کنید.", 502);
    }
    return new Response(upstream.body, {
      status: upstream.status,
      statusText: upstream.statusText,
      headers: proxyResponseHeaders(upstream, request),
    });
  } catch (error) {
    const timedOut = error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError");
    return errorPage(
      timedOut ? "مهلت اتصال WebSocket تمام شد" : "اتصال WebSocket برقرار نشد",
      "سرور مقصد اتصال WebSocket را نپذیرفت یا در دسترس نبود.",
      timedOut ? 504 : 502,
    );
  }
}

async function handleProxy(request: Request, env: Env): Promise<Response> {
  const proxyUrl = new URL(request.url);
  const isWebSocket = request.headers.get("Upgrade")?.toLowerCase() === "websocket";
  if (["CONNECT", "TRACE", "TRACK"].includes(request.method.toUpperCase())) {
    return errorPage("روش درخواست پشتیبانی نمی‌شود", "تونل CONNECT و روش‌های TRACE/TRACK در Cloudflare Workers در این برنامه فعال نیستند.", 405);
  }

  const auth = await principalForProxy(request, proxyUrl, env);
  if (auth.error) return auth.error;

  const rawTarget = proxyUrl.searchParams.get("url");
  if (!rawTarget) return errorPage("نشانی مقصد لازم است", "نشانی مقصد باید با پارامتر url به مسیر /proxy فرستاده شود.", 400);

  let preliminary: URL;
  try {
    preliminary = new URL(rawTarget);
  } catch {
    return errorPage("نشانی مقصد نامعتبر است", "نشانی کامل مانند https://example.com وارد کنید.", 400);
  }
  if (isWebSocket) {
    if (request.method !== "GET") return errorPage("درخواست WebSocket نامعتبر است", "ارتقای WebSocket فقط با روش GET انجام می‌شود.", 400);
    if (preliminary.protocol === "ws:") preliminary.protocol = "http:";
    else if (preliminary.protocol === "wss:") preliminary.protocol = "https:";
  }
  const target = appendFormQuery(proxyUrl, preliminary, request.method);
  const validation = validateProxyTarget(target.href, env.PROXY_ALLOWED_HOSTS);
  if (!validation.ok) {
    const missingAllowlist = allowedHostPatterns(env).length === 0;
    return errorPage(missingAllowlist ? "پروکسی هنوز تنظیم نشده است" : "دسترسی به این مقصد مسدود است", validation.reason, missingAllowlist ? 503 : 403);
  }

  if (request.method === "OPTIONS" && request.headers.has("Access-Control-Request-Method")) {
    return corsPreflight(request);
  }
  if (isWebSocket) return handleWebSocketProxy(request, validation.url, env);
  if (!/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(request.method)) {
    return errorPage("روش درخواست نامعتبر است", "نام روش HTTP شامل نویسه‌های غیرمجاز است.", 400);
  }
  if (request.method.toUpperCase() === "OPTIONS" && !request.headers.has("Access-Control-Request-Method")) {
    // An actual OPTIONS request (not a browser CORS preflight) is proxied below.
  }

  const contentLength = Number(request.headers.get("Content-Length") ?? 0);
  const bodyLimit = maxBodyBytes(env);
  if (Number.isFinite(contentLength) && contentLength > bodyLimit) {
    return errorPage("درخواست بیش از حد بزرگ است", `حداکثر اندازهٔ بدنهٔ درخواست ${bodyLimit} بایت است.`, 413);
  }

  const appOrigin = new URL(request.url).origin;
  const headers = cleanRequestHeaders(request, appOrigin, validation.url);
  const hasBody = request.method !== "GET" && request.method !== "HEAD";
  let body: ReadableStream<Uint8Array> | null = null;
  try {
    body = hasBody ? limitedBody(request.body as ReadableStream<Uint8Array> | null, bodyLimit) : null;
    const timeout = proxyTimeoutMs(env);
    const upstream = await fetch(validation.url.href, {
      method: request.method,
      headers,
      body,
      redirect: "manual",
      signal: AbortSignal.timeout(timeout),
    });

    const responseHeaders = proxyResponseHeaders(upstream, request);
    const location = upstream.headers.get("Location");
    if (location && upstream.status >= 300 && upstream.status < 400) {
      let redirected: URL;
      try {
        redirected = new URL(location, validation.url);
      } catch {
        return errorPage("پاسخ انتقال نامعتبر است", "مقصد ریدایرکت از سرور مقصد قابل پردازش نیست.", 502);
      }
      const redirectValidation = validateProxyTarget(redirected.href, env.PROXY_ALLOWED_HOSTS);
      if (!redirectValidation.ok) {
        return errorPage("ریدایرکت خارج از فهرست مجاز است", redirectValidation.reason, 403);
      }
      const capability = await mintProxyCapability(auth.principal, env);
      responseHeaders.set("Location", proxyPath(redirectValidation.url, capability));
      return new Response(null, { status: upstream.status, statusText: upstream.statusText, headers: responseHeaders });
    }

    const contentType = upstream.headers.get("Content-Type")?.toLowerCase() ?? "";
    if (contentType.includes("text/html") || contentType.includes("application/xhtml+xml")) {
      const capability = await mintProxyCapability(auth.principal, env);
      const htmlHeaders = new Headers(responseHeaders);
      // HTMLRewriter streams and may adjust content length/encoding itself.
      htmlHeaders.delete("content-length");
      htmlHeaders.delete("content-encoding");
      const transformed = rewriteHtml(new Response(upstream.body, {
        status: upstream.status,
        statusText: upstream.statusText,
        headers: htmlHeaders,
      }), validation.url, capability);
      return transformed;
    }

    const cssLength = Number(upstream.headers.get("Content-Length") ?? 0);
    if (contentType.includes("text/css") && cssLength > 0 && cssLength <= MAX_CSS_REWRITE_BYTES && upstream.body) {
      const css = await upstream.text();
      const capability = await mintProxyCapability(auth.principal, env);
      const rewritten = rewriteCss(css, validation.url, capability);
      responseHeaders.delete("content-length");
      responseHeaders.delete("content-encoding");
      responseHeaders.set("Content-Type", contentType);
      return new Response(rewritten, {
        status: upstream.status,
        statusText: upstream.statusText,
        headers: responseHeaders,
      });
    }

    return new Response(upstream.body, {
      status: upstream.status,
      statusText: upstream.statusText,
      headers: responseHeaders,
    });
  } catch (error) {
    if (error instanceof BodyLimitError || (error instanceof Error && error.name === "BodyLimitError")) {
      return errorPage("درخواست بیش از حد بزرگ است", `حداکثر اندازهٔ بدنهٔ درخواست ${bodyLimit} بایت است.`, 413);
    }
    const timedOut = error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError");
    return errorPage(
      timedOut ? "مهلت اتصال تمام شد" : "اتصال به مقصد ناموفق بود",
      timedOut ? "سرور مقصد در زمان تعیین‌شده پاسخ نداد." : "اتصال امن به سرور مقصد برقرار نشد. نام دامنه، allowlist و وضعیت شبکه را بررسی کنید.",
      timedOut ? 504 : 502,
    );
  }
}

function appBaseUrl(request: Request, env: Env): URL {
  const base = env.APP_BASE_URL?.trim();
  if (!base) return new URL(request.url).origin === "null" ? new URL(request.url) : new URL(new URL(request.url).origin);
  const parsed = new URL(base);
  if (parsed.protocol !== "https:" && parsed.hostname !== "localhost" && parsed.hostname !== "127.0.0.1") {
    throw new Error("APP_BASE_URL must use HTTPS outside localhost.");
  }
  return new URL(parsed.origin);
}

function randomToken(bytes = 32): string {
  const data = new Uint8Array(bytes);
  crypto.getRandomValues(data);
  return base64UrlEncode(data);
}

function emailAllowed(email: string, env: Env): boolean {
  const normalized = email.trim().toLowerCase();
  const emails = (env.GOOGLE_ALLOWED_EMAILS ?? "")
    .split(",")
    .map((value) => value.trim().toLowerCase())
    .filter(Boolean);
  const domains = (env.GOOGLE_ALLOWED_DOMAIN ?? "")
    .split(",")
    .map((value) => value.trim().toLowerCase().replace(/^@/, ""))
    .filter(Boolean);
  if (emails.length === 0 && domains.length === 0) return false;
  if (emails.includes(normalized)) return true;
  const domain = normalized.split("@").at(-1) ?? "";
  return domains.includes(domain);
}

async function handleGoogleStart(request: Request, env: Env): Promise<Response> {
  if (!googleConfigured(env)) return errorPage("ورود گوگل آماده نیست", authConfigMessage(env), 503);
  let base: URL;
  try {
    base = appBaseUrl(request, env);
  } catch {
    return errorPage("نشانی برنامه معتبر نیست", "APP_BASE_URL باید نشانی HTTPS اصلی Worker باشد.", 500);
  }

  const state = randomToken();
  const nonce = randomToken();
  const signedState = await signPayload(
    { state, nonce, exp: Math.floor(Date.now() / 1000) + OAUTH_STATE_TTL_SECONDS, typ: "oauth-state" } satisfies OAuthState,
    env,
  );
  const authorization = new URL("https://accounts.google.com/o/oauth2/v2/auth");
  authorization.searchParams.set("client_id", env.GOOGLE_CLIENT_ID!.trim());
  authorization.searchParams.set("redirect_uri", new URL("/auth/callback", base).href);
  authorization.searchParams.set("response_type", "code");
  authorization.searchParams.set("scope", "openid email profile");
  authorization.searchParams.set("state", state);
  authorization.searchParams.set("nonce", nonce);
  authorization.searchParams.set("prompt", "select_account");
  const headers = new Headers({ Location: authorization.href, "Cache-Control": "no-store" });
  headers.append("Set-Cookie", cookieValue(OAUTH_COOKIE, signedState, request, OAUTH_STATE_TTL_SECONDS));
  return new Response(null, { status: 302, headers });
}

async function googleIdentityToken(idToken: string, env: Env, expectedNonce: string): Promise<SessionUser> {
  const endpoint = new URL("https://oauth2.googleapis.com/tokeninfo");
  endpoint.searchParams.set("id_token", idToken);
  const response = await fetch(endpoint.href, {
    headers: { Accept: "application/json" },
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) throw new Error("Google ID token validation failed.");
  const claims = await response.json() as Record<string, unknown>;
  const expires = Number(claims.exp);
  const issuer = String(claims.iss ?? "");
  const verified = claims.email_verified === true || claims.email_verified === "true";
  if (
    claims.aud !== env.GOOGLE_CLIENT_ID?.trim() ||
    (issuer !== "accounts.google.com" && issuer !== "https://accounts.google.com") ||
    !Number.isFinite(expires) || expires <= Date.now() / 1000 ||
    claims.nonce !== expectedNonce ||
    !verified ||
    typeof claims.sub !== "string" ||
    typeof claims.email !== "string" ||
    !emailAllowed(claims.email, env)
  ) {
    throw new Error("Google account claims were invalid or not allowed.");
  }
  return {
    sub: claims.sub,
    email: claims.email.toLowerCase(),
    name: typeof claims.name === "string" ? claims.name : undefined,
    picture: typeof claims.picture === "string" ? claims.picture : undefined,
    exp: Math.floor(Date.now() / 1000) + SESSION_TTL_SECONDS,
    typ: "session",
  };
}

async function handleGoogleCallback(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const stateFromQuery = url.searchParams.get("state");
  const code = url.searchParams.get("code");
  const stateCookie = await verifyPayload<OAuthState>(readCookie(request, OAUTH_COOKIE), "oauth-state", env);
  const clearState = clearCookie(OAUTH_COOKIE, request);

  if (url.searchParams.has("error")) {
    const response = errorPage("ورود گوگل لغو شد", "در صورت تمایل، دوباره از صفحهٔ اصلی وارد شوید.", 400);
    response.headers.append("Set-Cookie", clearState);
    return response;
  }
  if (!googleConfigured(env) || !stateCookie || !stateFromQuery || stateFromQuery !== stateCookie.state || !code) {
    const response = errorPage("تأیید ورود ناموفق بود", "درخواست ورود معتبر نیست یا منقضی شده است. دوباره تلاش کنید.", 400);
    response.headers.append("Set-Cookie", clearState);
    return response;
  }

  let base: URL;
  try {
    base = appBaseUrl(request, env);
  } catch {
    return errorPage("نشانی برنامه معتبر نیست", "APP_BASE_URL را در تنظیمات Worker بررسی کنید.", 500);
  }

  try {
    const tokenResponse = await fetch("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
      body: new URLSearchParams({
        code,
        client_id: env.GOOGLE_CLIENT_ID!.trim(),
        client_secret: env.GOOGLE_CLIENT_SECRET!.trim(),
        redirect_uri: new URL("/auth/callback", base).href,
        grant_type: "authorization_code",
      }),
      signal: AbortSignal.timeout(10_000),
    });
    const tokenData = await tokenResponse.json() as { id_token?: string; error?: string };
    if (!tokenResponse.ok || !tokenData.id_token) throw new Error("Google token exchange failed.");
    const user = await googleIdentityToken(tokenData.id_token, env, stateCookie.nonce);
    const sessionToken = await signPayload(user, env);
    const headers = new Headers({ Location: "/", "Cache-Control": "no-store" });
    headers.append("Set-Cookie", cookieValue(SESSION_COOKIE, sessionToken, request, SESSION_TTL_SECONDS));
    headers.append("Set-Cookie", clearState);
    return new Response(null, { status: 303, headers });
  } catch {
    const response = errorPage("ورود گوگل ناموفق بود", "اعتبارسنجی حساب انجام نشد یا دسترسی این حساب مجاز نیست.", 401);
    response.headers.append("Set-Cookie", clearState);
    return response;
  }
}

async function handleSession(request: Request, env: Env): Promise<Response> {
  const user = await readSession(request, env);
  const authIsRequired = authRequired(env);
  const proxyCapability = user ? await mintProxyCapability({ sub: user.sub }, env) : null;
  return json({
    authRequired: authIsRequired,
    authConfigured: googleConfigured(env),
    authenticated: Boolean(user),
    user: user ? { email: user.email, name: user.name ?? null, picture: user.picture ?? null } : null,
    proxyCapability,
    proxyCapabilityExpiresAt: proxyCapability ? (Date.now() + PROXY_CAP_TTL_SECONDS * 1000) : null,
    proxyConfigured: allowedHostPatterns(env).length > 0,
    ready: allowedHostPatterns(env).length > 0 && (!authIsRequired || googleConfigured(env)),
  });
}

function sameOriginRequest(request: Request): boolean {
  const origin = request.headers.get("Origin");
  if (!origin) return false;
  return origin === new URL(request.url).origin;
}

async function handleLogout(request: Request, env: Env): Promise<Response> {
  if (request.method !== "POST") return json({ error: "Method not allowed" }, 405, new Headers({ Allow: "POST" }));
  if (!sameOriginRequest(request)) return json({ error: "Invalid request origin" }, 403);
  const headers = new Headers();
  headers.append("Set-Cookie", clearCookie(SESSION_COOKIE, request));
  return json({ ok: true }, 200, headers);
}

function shellSecurityHeaders(response: Response): Response {
  const headers = new Headers(response.headers);
  headers.set("X-Content-Type-Options", "nosniff");
  headers.set("Referrer-Policy", "no-referrer");
  headers.set("X-Frame-Options", "DENY");
  headers.set("Permissions-Policy", "camera=(), microphone=(), geolocation=(), payment=()");
  headers.set(
    "Content-Security-Policy",
    "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data: blob:; frame-src 'self'; connect-src 'self'; form-action 'self'; base-uri 'self'; object-src 'none'; frame-ancestors 'none'",
  );
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}

async function fetchAsset(request: Request, env: Env): Promise<Response> {
  const asset = await env.ASSETS.fetch(request);
  if (asset.status !== 404 || request.method !== "GET") return shellSecurityHeaders(asset);
  const fallbackUrl = new URL("/", request.url);
  return shellSecurityHeaders(await env.ASSETS.fetch(new Request(fallbackUrl, request)));
}

const worker = {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/healthz") return json({ ok: true, service: "sepehr-worker-browser" });
    if (url.pathname === "/api/session") return handleSession(request, env);
    if (url.pathname === "/api/logout") return handleLogout(request, env);
    if (url.pathname === "/auth/google") return handleGoogleStart(request, env);
    if (url.pathname === "/auth/callback") return handleGoogleCallback(request, env);
    if (url.pathname === "/proxy") return handleProxy(request, env);
    return fetchAsset(request, env);
  },
};

export default worker;
