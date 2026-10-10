import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const publicUrl = (name) => new URL(`../public/${name}`, import.meta.url);
const manifest = JSON.parse(readFileSync(publicUrl("manifest.webmanifest"), "utf8"));

describe("mobile PWA shell", () => {
  it("declares an installable standalone application and required icon sizes", () => {
    expect(manifest.display).toBe("standalone");
    expect(manifest.start_url).toBe("/?source=pwa");
    expect(manifest.scope).toBe("/");
    expect(manifest.lang).toBe("fa");
    expect(manifest.dir).toBe("rtl");

    for (const size of ["192x192", "512x512"]) {
      const icon = manifest.icons.find((entry) => entry.sizes === size && entry.purpose === "any");
      expect(icon, `missing ${size} PWA icon`).toBeTruthy();
      const bytes = readFileSync(publicUrl(icon.src.slice(1)));
      expect(bytes.subarray(0, 8)).toEqual(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
    }

    expect(manifest.icons.some((entry) => entry.purpose === "maskable" && entry.sizes === "512x512")).toBe(true);
  });

  it("exposes install metadata and a mobile install control in the app shell", () => {
    const html = readFileSync(publicUrl("index.html"), "utf8");
    const app = readFileSync(publicUrl("app.js"), "utf8");
    expect(html).toContain('rel="manifest" href="/manifest.webmanifest"');
    expect(html).toContain('id="install-button"');
    expect(html).toContain('id="install-dialog"');
    expect(app).toContain('navigator.serviceWorker.register("/sw.js"');
    expect(app).toContain('window.addEventListener("beforeinstallprompt"');
  });

  it("keeps proxied pages and private session endpoints out of offline caches", () => {
    const serviceWorker = readFileSync(publicUrl("sw.js"), "utf8");
    expect(serviceWorker).toContain('url.pathname === "/proxy"');
    expect(serviceWorker).toContain('url.pathname.startsWith("/api/")');
    expect(serviceWorker).toContain('url.pathname.startsWith("/auth/")');
  });
});
