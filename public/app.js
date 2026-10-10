const STORAGE = {
  bookmarks: "sepehr.bookmarks.v1",
  history: "sepehr.history.v1",
  shortcuts: "sepehr.shortcuts.v1",
};
const MAX_TABS = 20;
const MAX_HISTORY = 100;

const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];

function readStorage(key, fallback) {
  try {
    const value = JSON.parse(localStorage.getItem(key) || "null");
    return Array.isArray(value) ? value : fallback;
  } catch {
    return fallback;
  }
}

function writeStorage(key, value) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    showToast("ذخیرهٔ محلی در این مرورگر در دسترس نیست.", true);
  }
}

function safeWebUrl(value) {
  if (typeof value !== "string" || value.length > 8192) return null;
  try {
    const url = new URL(value);
    return url.protocol === "https:" || url.protocol === "http:" ? url : null;
  } catch {
    return null;
  }
}

function normalizeInput(value) {
  const input = value.trim();
  if (!input) return null;
  if (/^(?:javascript|data|file|blob):/i.test(input)) return null;
  if (/\s/.test(input) && !/^https?:\/\//i.test(input)) {
    return new URL(`https://www.google.com/search?q=${encodeURIComponent(input)}`);
  }
  const candidate = /^[a-z][a-z\d+.-]*:\/\//i.test(input) ? input : `https://${input}`;
  return safeWebUrl(candidate);
}

function faNumber(value) {
  return String(value).replace(/\d/g, (digit) => "۰۱۲۳۴۵۶۷۸۹"[Number(digit)]);
}

function safeShortUrl(url) {
  try {
    const parsed = new URL(url);
    return `${parsed.host}${parsed.pathname === "/" ? "" : parsed.pathname}`;
  } catch {
    return url;
  }
}

const state = {
  authRequired: true,
  authConfigured: false,
  authenticated: false,
  user: null,
  proxyCapability: null,
  proxyCapabilityExpiresAt: 0,
  proxyConfigured: false,
  ready: false,
};

let tabs = [];
let activeTabId = null;
let nextTabId = 1;
let bookmarks = readStorage(STORAGE.bookmarks, []).filter((item) => item && safeWebUrl(item.url));
let historyItems = readStorage(STORAGE.history, []).filter((item) => item && safeWebUrl(item.url)).slice(0, MAX_HISTORY);
let shortcuts = readStorage(STORAGE.shortcuts, []).filter((item) => item && typeof item.title === "string" && safeWebUrl(item.url));
let currentLibrary = "bookmarks";
let toastTimer = 0;
let deferredInstallPrompt = null;

const elements = {
  tabStrip: $("#tab-strip"),
  newTabButton: $("#new-tab-button"),
  tabPanels: $("#tab-panels"),
  addressForm: $("#address-form"),
  addressInput: $("#address-input"),
  addressDomain: $("#address-domain"),
  clearAddress: $("#clear-address-button"),
  back: $("#back-button"),
  forward: $("#forward-button"),
  reload: $("#reload-button"),
  home: $("#home-button"),
  bookmark: $("#bookmark-button"),
  connectionIndicator: $("#connection-indicator"),
  connectionLabel: $("#connection-label"),
  footerStatus: $("#footer-status"),
  tabCount: $("#tab-count"),
  authButton: $("#auth-button"),
  installButton: $("#install-button"),
  installDialog: $("#install-dialog"),
  installInstructions: $("#install-instructions"),
  authButtonLabel: $("#auth-button-label"),
  profileControl: $("#profile-control"),
  profileButton: $("#profile-button"),
  profileMenu: $("#profile-menu"),
  profileName: $("#profile-name"),
  profileEmail: $("#profile-email"),
  profileAvatar: $("#profile-avatar"),
  logout: $("#logout-button"),
  bookmarkShelf: $("#bookmark-shelf"),
  loading: $("#loading-indicator"),
  toast: $("#toast"),
  settingsDialog: $("#settings-dialog"),
  libraryDialog: $("#library-dialog"),
  shortcutDialog: $("#shortcut-dialog"),
  libraryList: $("#library-list"),
  libraryEmpty: $("#library-empty"),
  setupStatusCard: $("#settings-status-card"),
  setupTitle: $("#settings-status-title"),
  setupDescription: $("#settings-status-description"),
  settingsAuth: $("#settings-auth-state"),
  settingsProxy: $("#settings-proxy-state"),
  shortcutForm: $("#shortcut-form"),
};

function isStandaloneMode() {
  const displayMode = window.matchMedia ? window.matchMedia("(display-mode: standalone)").matches : false;
  return displayMode || window.navigator.standalone === true;
}

window.addEventListener("beforeinstallprompt", (event) => {
  event.preventDefault();
  deferredInstallPrompt = event;
  if (!isStandaloneMode()) elements.installButton.hidden = false;
});

window.addEventListener("appinstalled", () => {
  deferredInstallPrompt = null;
  elements.installButton.hidden = true;
});

function showToast(message, isError = false) {
  elements.toast.textContent = message;
  elements.toast.classList.toggle("is-error", isError);
  elements.toast.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => elements.toast.classList.remove("show"), 3000);
}

function setStatus(message, mode = "ready") {
  elements.footerStatus.textContent = message;
  elements.connectionLabel.textContent = message;
  elements.connectionIndicator.classList.toggle("is-ready", mode === "ready");
  elements.connectionIndicator.classList.toggle("is-error", mode === "error");
  const shield = $("#address-shield");
  shield.classList.toggle("is-warning", mode === "warning");
  shield.classList.toggle("is-error", mode === "error");
}

function renderAuth() {
  const loggedIn = state.authenticated && state.user;
  elements.profileControl.hidden = !loggedIn;
  elements.authButton.hidden = Boolean(loggedIn) || !state.authConfigured;
  if (loggedIn) {
    const displayName = state.user.name || state.user.email;
    elements.profileName.textContent = displayName;
    elements.profileEmail.textContent = state.user.email;
    elements.profileAvatar.textContent = (displayName.trim()[0] || "س").toLocaleUpperCase("fa-IR");
  } else {
    elements.authButtonLabel.textContent = "ورود با گوگل";
  }
}

function updateSetupBanner(tab) {
  const banner = $(".setup-banner", tab.homeView);
  if (!banner) return;
  const title = $(".setup-title", banner);
  const description = $(".setup-description", banner);
  const loginButton = $(".setup-login-button", banner);
  let show = false;
  let headline = "پیکربندی سرویس";
  let detail = "برای شروع، تنظیمات Worker را بررسی کنید.";
  let canLogin = false;

  if (!state.proxyConfigured) {
    show = true;
    headline = "فهرست مقصدهای مجاز خالی است";
    detail = "مدیر باید PROXY_ALLOWED_HOSTS را در تنظیمات Cloudflare مشخص کند.";
  } else if (state.authRequired && !state.authConfigured) {
    show = true;
    headline = "ورود امن آماده نیست";
    detail = "کلیدهای Google OAuth، SESSION_SECRET و allowlist ایمیل‌های مجاز را روی Worker تنظیم کنید.";
  } else if (state.authRequired && !state.authenticated) {
    show = true;
    headline = "برای مرور وارد شوید";
    detail = "ورود با گوگل، دسترسی این مرورگر را به حساب شما محدود می‌کند.";
    canLogin = state.authConfigured;
  }

  banner.hidden = !show;
  title.textContent = headline;
  description.textContent = detail;
  loginButton.hidden = !canLogin;
}

function updateAllHomeBanners() {
  for (const tab of tabs) updateSetupBanner(tab);
}

function updateConnectionState() {
  if (!state.proxyConfigured) {
    setStatus("نیاز به تنظیم فهرست مقصد", "error");
  } else if (state.authRequired && !state.authConfigured) {
    setStatus("ورود گوگل پیکربندی نشده", "error");
  } else if (state.authRequired && !state.authenticated) {
    setStatus("ورود برای مرور لازم است", "warning");
  } else {
    setStatus("پروکسی امن فعال", "ready");
  }
  renderAuth();
  updateAllHomeBanners();
  updateSettingsStatus();
}

function updateSettingsStatus() {
  if (!state.proxyConfigured) {
    elements.setupStatusCard.style.borderColor = "rgba(242, 189, 114, .22)";
    elements.setupTitle.textContent = "پروکسی هنوز آماده نیست";
    elements.setupDescription.textContent = "پیکربندی allowlist برای جلوگیری از پروکسی باز الزامی است.";
    elements.settingsProxy.textContent = "PROXY_ALLOWED_HOSTS خالی است؛ هیچ دامنه‌ای قابل دسترسی نیست.";
  } else {
    elements.setupStatusCard.style.borderColor = "rgba(112, 216, 186, .16)";
    elements.setupTitle.textContent = state.ready ? "اتصال محدود و آماده است" : "پیکربندی تقریباً کامل است";
    elements.setupDescription.textContent = "مقصدهای غیرمجاز و نشانی‌های خصوصی در لایهٔ Worker رد می‌شوند.";
    elements.settingsProxy.textContent = "فهرست مقصدها تنظیم شده؛ دامنه‌های خارج از آن مسدود هستند.";
  }
  elements.settingsAuth.textContent = !state.authRequired
    ? "ورود اجباری خاموش است؛ فقط در محیط کنترل‌شده و با allowlist محدود استفاده کنید."
    : state.authConfigured
      ? state.authenticated
        ? `ورود فعال است: ${state.user?.email ?? "حساب گوگل"}`
        : "ورود گوگل فعال است و پیش از استفاده لازم است."
      : "OAuth گوگل یا SESSION_SECRET هنوز پیکربندی نشده است.";
}

async function refreshSession() {
  try {
    const response = await fetch("/api/session", { cache: "no-store", credentials: "same-origin" });
    if (!response.ok) throw new Error("Session status request failed.");
    const data = await response.json();
    Object.assign(state, data);
  } catch {
    state.ready = false;
    state.proxyConfigured = false;
    state.proxyCapability = null;
    state.proxyCapabilityExpiresAt = 0;
    showToast("وضعیت سرویس دریافت نشد؛ اتصال Worker را بررسی کنید.", true);
  }
  updateConnectionState();
}

async function freshProxyCapability() {
  if (!state.authRequired || !state.authenticated) return null;
  if (state.proxyCapability && Number(state.proxyCapabilityExpiresAt) > Date.now() + 45_000) {
    return state.proxyCapability;
  }
  await refreshSession();
  return typeof state.proxyCapability === "string" ? state.proxyCapability : null;
}

function guardNavigation() {
  if (!state.proxyConfigured) {
    showToast("مدیر باید ابتدا PROXY_ALLOWED_HOSTS را تنظیم کند.", true);
    return false;
  }
  if (state.authRequired && !state.authConfigured) {
    showToast("ورود گوگل روی Worker پیکربندی نشده است.", true);
    return false;
  }
  if (state.authRequired && !state.authenticated) {
    showToast("برای شروع با حساب گوگل وارد شوید.", true);
    return false;
  }
  return true;
}

function createTab({ activate = true } = {}) {
  if (tabs.length >= MAX_TABS) {
    showToast(`حداکثر ${faNumber(MAX_TABS)} برگه باز می‌شود.`, true);
    return null;
  }

  const id = `tab-${nextTabId++}`;
  const panel = document.createElement("section");
  panel.className = "tab-panel";
  panel.id = id;
  panel.setAttribute("aria-label", "محتوای برگهٔ جدید");
  panel.hidden = true;

  const template = $("#startup-template");
  const homeFragment = template.content.cloneNode(true);
  const homeView = $(".startup-view", homeFragment);
  panel.append(homeView);

  const remoteView = document.createElement("div");
  remoteView.className = "remote-view";
  remoteView.hidden = true;
  const iframe = document.createElement("iframe");
  iframe.title = "صفحهٔ وب پروکسی‌شده";
  iframe.setAttribute("sandbox", "allow-scripts allow-forms allow-downloads allow-modals allow-popups");
  iframe.setAttribute("referrerpolicy", "no-referrer");
  remoteView.append(iframe);
  panel.append(remoteView);

  const tab = {
    id,
    title: "برگهٔ تازه",
    url: "",
    history: [],
    historyIndex: -1,
    panel,
    homeView,
    remoteView,
    iframe,
    tabButton: null,
  };
  tabs.push(tab);
  elements.tabPanels.append(panel);

  iframe.addEventListener("load", () => {
    if (activeTabId === id) {
      elements.loading.hidden = true;
      if (tab.url && state.ready && (!state.authRequired || state.authenticated)) {
        setStatus(`صفحهٔ ${safeShortUrl(tab.url)} بارگذاری شد`, "ready");
      } else {
        updateConnectionState();
      }
    }
  });

  panel.addEventListener("submit", (event) => {
    const form = event.target;
    if (!(form instanceof HTMLFormElement) || !form.matches(".quick-search")) return;
    event.preventDefault();
    navigateFromInput($(".quick-search-input", form).value, tab);
  });
  panel.addEventListener("click", (event) => {
    const target = event.target instanceof Element ? event.target : null;
    if (!target) return;
    const link = target.closest("[data-url]");
    if (link) {
      navigateFromInput(link.getAttribute("data-url") || "", tab);
      return;
    }
    if (target.closest(".add-shortcut-button")) {
      elements.shortcutDialog.showModal();
      return;
    }
    if (target.closest(".learn-more-button")) {
      elements.settingsDialog.showModal();
      return;
    }
    const login = target.closest(".setup-login-button");
    if (login && !login.hidden) startGoogleLogin();
  });

  renderTabs();
  renderHomeShortcuts(tab);
  updateSetupBanner(tab);
  if (activate) activateTab(id);
  return tab;
}

function renderTabs() {
  $$(".tab", elements.tabStrip).forEach((button) => button.remove());
  for (const tab of tabs) {
    const button = document.createElement("div");
    button.className = `tab${tab.id === activeTabId ? " active" : ""}`;
    button.tabIndex = 0;
    button.setAttribute("role", "tab");
    button.setAttribute("aria-selected", tab.id === activeTabId ? "true" : "false");
    button.setAttribute("aria-controls", tab.id);
    button.title = tab.title;

    const favicon = document.createElement("span");
    favicon.className = "tab-favicon";
    favicon.setAttribute("aria-hidden", "true");
    favicon.textContent = tab.url ? (new URL(tab.url).hostname[0] || "و").toUpperCase() : "✦";
    const title = document.createElement("span");
    title.className = "tab-title";
    title.textContent = tab.title;
    const close = document.createElement("button");
    close.className = "tab-close";
    close.type = "button";
    close.textContent = "×";
    close.setAttribute("aria-label", `بستن ${tab.title}`);
    close.title = "بستن برگه";
    close.addEventListener("click", (event) => {
      event.stopPropagation();
      closeTab(tab.id);
    });

    button.append(favicon, title, close);
    button.addEventListener("click", () => activateTab(tab.id));
    button.addEventListener("keydown", (event) => {
      if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        activateTab(tab.id);
      }
    });
    tab.tabButton = button;
    elements.tabStrip.insertBefore(button, elements.newTabButton);
  }
  elements.tabCount.textContent = `${faNumber(tabs.length)} برگه`;
}

function activateTab(id) {
  const tab = tabs.find((item) => item.id === id);
  if (!tab) return;
  activeTabId = id;
  for (const item of tabs) {
    item.panel.hidden = item.id !== id;
    if (item.tabButton) {
      item.tabButton.classList.toggle("active", item.id === id);
      item.tabButton.setAttribute("aria-selected", item.id === id ? "true" : "false");
    }
  }
  elements.loading.hidden = true;
  syncToolbar();
  renderTabs();
  tab.tabButton?.scrollIntoView({ block: "nearest", inline: "nearest" });
}

function closeTab(id) {
  const index = tabs.findIndex((tab) => tab.id === id);
  if (index < 0) return;
  const wasActive = activeTabId === id;
  tabs[index].iframe.src = "about:blank";
  tabs[index].panel.remove();
  tabs.splice(index, 1);
  if (tabs.length === 0) {
    activeTabId = null;
    createTab({ activate: true });
    return;
  }
  if (wasActive) {
    const neighbor = tabs[Math.max(0, index - 1)] || tabs[0];
    activeTabId = neighbor.id;
  }
  renderTabs();
  if (activeTabId) activateTab(activeTabId);
}

function activeTab() {
  return tabs.find((tab) => tab.id === activeTabId) || null;
}

function syncToolbar() {
  const tab = activeTab();
  if (!tab) return;
  elements.addressInput.value = tab.url;
  elements.addressDomain.hidden = !tab.url;
  elements.addressDomain.textContent = tab.url ? new URL(tab.url).hostname : "";
  elements.clearAddress.hidden = !elements.addressInput.value;
  elements.back.disabled = tab.historyIndex <= 0;
  elements.forward.disabled = tab.historyIndex >= tab.history.length - 1;
  elements.bookmark.disabled = !tab.url;
  const isBookmarked = tab.url && bookmarks.some((item) => item.url === tab.url);
  elements.bookmark.classList.toggle("bookmark-button-active", Boolean(isBookmarked));
  elements.bookmark.title = isBookmarked ? "حذف نشانک" : "افزودن نشانک";
  elements.bookmark.setAttribute("aria-label", elements.bookmark.title);
}

function setAddress(target) {
  const tab = activeTab();
  if (!tab) return;
  elements.addressInput.value = target;
  elements.addressDomain.hidden = false;
  elements.addressDomain.textContent = new URL(target).hostname;
  elements.clearAddress.hidden = false;
}

function navigateFromInput(raw, tab = activeTab()) {
  if (!tab) return;
  const target = normalizeInput(raw);
  if (!target) {
    showToast("نشانی وب معتبر وارد کنید.", true);
    return;
  }
  navigateTab(tab, target.href, { push: true });
}

async function navigateTab(tab, url, { push = true } = {}) {
  if (!guardNavigation()) return;
  const target = safeWebUrl(url);
  if (!target) {
    showToast("فقط نشانی‌های HTTP و HTTPS قابل مرور هستند.", true);
    return;
  }

  tab.navigationSequence = (tab.navigationSequence || 0) + 1;
  const sequence = tab.navigationSequence;
  tab.url = target.href;
  tab.title = target.hostname;
  if (push) {
    tab.history = tab.history.slice(0, tab.historyIndex + 1);
    if (tab.history[tab.history.length - 1] !== target.href) tab.history.push(target.href);
    if (tab.history.length > 50) tab.history.shift();
    tab.historyIndex = tab.history.length - 1;
    recordHistory(target.href, tab.title);
  }

  tab.homeView.hidden = true;
  tab.remoteView.hidden = false;
  if (activeTabId === tab.id) {
    setAddress(target.href);
    elements.loading.hidden = false;
    setStatus(`در حال اتصال به ${target.hostname}`, "warning");
  }
  renderTabs();
  syncToolbar();

  const capability = await freshProxyCapability();
  if (!tabs.includes(tab) || tab.navigationSequence !== sequence) return;
  if (state.authRequired && !state.authenticated) {
    tab.homeView.hidden = false;
    tab.remoteView.hidden = true;
    if (activeTabId === tab.id) syncToolbar();
    updateConnectionState();
    return;
  }
  const query = new URLSearchParams({ url: target.href });
  if (capability) query.set("cap", capability);
  tab.iframe.src = `/proxy?${query.toString()}`;
}

function showHome(tab = activeTab()) {
  if (!tab) return;
  tab.navigationSequence = (tab.navigationSequence || 0) + 1;
  tab.iframe.src = "about:blank";
  tab.url = "";
  tab.title = "برگهٔ تازه";
  tab.homeView.hidden = false;
  tab.remoteView.hidden = true;
  elements.loading.hidden = true;
  renderTabs();
  syncToolbar();
  updateSetupBanner(tab);
  updateConnectionState();
}

function moveHistory(offset) {
  const tab = activeTab();
  if (!tab) return;
  const next = tab.historyIndex + offset;
  if (next < 0 || next >= tab.history.length) return;
  tab.historyIndex = next;
  const url = tab.history[next];
  navigateTab(tab, url, { push: false });
}

function recordHistory(url, title) {
  const now = Date.now();
  const existing = historyItems.find((item) => item.url === url);
  historyItems = historyItems.filter((item) => item.url !== url);
  historyItems.unshift({ url, title: title || safeShortUrl(url), visitedAt: now });
  historyItems = historyItems.slice(0, MAX_HISTORY);
  if (existing && existing.title && !title) historyItems[0].title = existing.title;
  writeStorage(STORAGE.history, historyItems);
}

function updateHistoryTitle(url, title) {
  const entry = historyItems.find((item) => item.url === url);
  if (entry && title) {
    entry.title = title;
    writeStorage(STORAGE.history, historyItems);
  }
}

function renderShelf() {
  elements.bookmarkShelf.replaceChildren();
  const visible = bookmarks.slice(0, 8);
  if (visible.length === 0) {
    const empty = document.createElement("span");
    empty.className = "shelf-empty";
    empty.textContent = "نشانک‌های شما اینجا نمایش داده می‌شوند";
    elements.bookmarkShelf.append(empty);
    return;
  }
  for (const item of visible) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "shelf-chip";
    button.title = item.url;
    const icon = document.createElement("span");
    icon.className = "shelf-favicon";
    icon.textContent = (safeWebUrl(item.url)?.hostname[0] || "و").toUpperCase();
    const label = document.createElement("span");
    label.textContent = item.title || safeShortUrl(item.url);
    button.append(icon, label);
    button.addEventListener("click", () => navigateFromInput(item.url));
    elements.bookmarkShelf.append(button);
  }
}

function renderHomeShortcuts(tab) {
  const linkArea = $(".home-quicklinks", tab.homeView);
  if (!linkArea) return;
  for (const shortcut of shortcuts) {
    const button = document.createElement("button");
    button.className = "quicklink custom-quicklink";
    button.type = "button";
    button.dataset.url = shortcut.url;
    const icon = document.createElement("span");
    icon.className = "quicklink-icon";
    icon.textContent = (safeWebUrl(shortcut.url)?.hostname[0] || "↗").toUpperCase();
    const label = document.createElement("span");
    label.textContent = shortcut.title;
    button.append(icon, label);
    const addButton = $(".add-shortcut-button", linkArea);
    linkArea.insertBefore(button, addButton);
  }
}

function toggleBookmark() {
  const tab = activeTab();
  if (!tab?.url) return;
  const exists = bookmarks.some((item) => item.url === tab.url);
  if (exists) {
    bookmarks = bookmarks.filter((item) => item.url !== tab.url);
    showToast("نشانک حذف شد.");
  } else {
    bookmarks.unshift({ url: tab.url, title: tab.title || safeShortUrl(tab.url), addedAt: Date.now() });
    bookmarks = bookmarks.slice(0, 80);
    showToast("به نشانک‌ها اضافه شد.");
  }
  writeStorage(STORAGE.bookmarks, bookmarks);
  renderShelf();
  syncToolbar();
  if (elements.libraryDialog.open && currentLibrary === "bookmarks") renderLibrary();
}

function openLibrary(which = "bookmarks") {
  currentLibrary = which;
  $$(".library-tab").forEach((button) => button.classList.toggle("active", button.dataset.library === which));
  renderLibrary();
  if (!elements.libraryDialog.open) elements.libraryDialog.showModal();
}

function renderLibrary() {
  elements.libraryList.replaceChildren();
  const data = currentLibrary === "bookmarks" ? bookmarks : historyItems;
  elements.libraryEmpty.hidden = data.length > 0;
  $("#clear-history-button").hidden = currentLibrary !== "history" || historyItems.length === 0;
  for (const item of data) {
    const row = document.createElement("div");
    row.className = "library-row";
    const icon = document.createElement("span");
    icon.className = "library-row-icon";
    icon.textContent = (safeWebUrl(item.url)?.hostname[0] || "و").toUpperCase();
    const copy = document.createElement("div");
    copy.className = "library-row-copy";
    copy.tabIndex = 0;
    copy.setAttribute("role", "button");
    const title = document.createElement("strong");
    title.textContent = item.title || safeShortUrl(item.url);
    const url = document.createElement("span");
    url.textContent = item.url;
    copy.append(title, url);
    const open = () => {
      elements.libraryDialog.close();
      navigateFromInput(item.url);
    };
    copy.addEventListener("click", open);
    copy.addEventListener("keydown", (event) => {
      if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        open();
      }
    });
    const remove = document.createElement("button");
    remove.className = "library-row-remove";
    remove.type = "button";
    remove.setAttribute("aria-label", currentLibrary === "bookmarks" ? "حذف نشانک" : "حذف از تاریخچه");
    remove.textContent = "×";
    remove.addEventListener("click", () => {
      if (currentLibrary === "bookmarks") {
        bookmarks = bookmarks.filter((entry) => entry.url !== item.url);
        writeStorage(STORAGE.bookmarks, bookmarks);
        renderShelf();
      } else {
        historyItems = historyItems.filter((entry) => entry.url !== item.url);
        writeStorage(STORAGE.history, historyItems);
      }
      renderLibrary();
    });
    row.append(icon, copy, remove);
    elements.libraryList.append(row);
  }
}

function updateProfileMenu(open) {
  elements.profileMenu.hidden = !open;
  elements.profileButton.setAttribute("aria-expanded", open ? "true" : "false");
}

function showInstallGuide() {
  const userAgent = navigator.userAgent || "";
  const isIOS = /iPhone|iPad|iPod/i.test(userAgent) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
  if (isIOS) {
    elements.installInstructions.textContent = "در Safari دکمهٔ Share (اشتراک‌گذاری) را بزنید و سپس «Add to Home Screen» (افزودن به صفحهٔ اصلی) را انتخاب کنید.";
  } else if (/Android/i.test(userAgent)) {
    elements.installInstructions.textContent = "اگر پنجرهٔ نصب باز نشد، منوی مرورگر (⋮) را بزنید و «Install app» یا «Add to Home screen» را انتخاب کنید.";
  } else {
    elements.installInstructions.textContent = "از منوی مرورگر گزینهٔ «Install app» یا «افزودن به صفحهٔ اصلی» را انتخاب کنید.";
  }
  if (!elements.installDialog.open) elements.installDialog.showModal();
}

function setupPwaInstall() {
  const userAgent = navigator.userAgent || "";
  const isMobile = /Android|iPhone|iPad|iPod/i.test(userAgent) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
  elements.installButton.hidden = isStandaloneMode() || (!isMobile && !deferredInstallPrompt);
  elements.installButton.addEventListener("click", async () => {
    if (!deferredInstallPrompt) {
      showInstallGuide();
      return;
    }
    const promptEvent = deferredInstallPrompt;
    deferredInstallPrompt = null;
    try {
      await promptEvent.prompt();
      const choice = await promptEvent.userChoice;
      if (choice?.outcome === "accepted") elements.installButton.hidden = true;
    } catch {
      showInstallGuide();
    }
  });

  if ("serviceWorker" in navigator && window.isSecureContext) {
    navigator.serviceWorker.register("/sw.js", { scope: "/" }).catch(() => {});
  }
}

function startGoogleLogin() {
  if (!state.authConfigured) {
    showToast("ابتدا Google OAuth و SESSION_SECRET را در Worker تنظیم کنید.", true);
    return;
  }
  window.location.assign("/auth/google");
}

function setupEvents() {
  elements.newTabButton.addEventListener("click", () => createTab({ activate: true }));
  elements.addressForm.addEventListener("submit", (event) => {
    event.preventDefault();
    navigateFromInput(elements.addressInput.value);
    elements.addressInput.blur();
  });
  elements.addressInput.addEventListener("input", () => {
    elements.clearAddress.hidden = elements.addressInput.value.length === 0;
  });
  elements.addressInput.addEventListener("focus", () => elements.addressInput.select());
  elements.clearAddress.addEventListener("click", () => {
    elements.addressInput.value = "";
    elements.addressInput.focus();
    elements.clearAddress.hidden = true;
  });
  elements.back.addEventListener("click", () => moveHistory(-1));
  elements.forward.addEventListener("click", () => moveHistory(1));
  elements.reload.addEventListener("click", () => {
    const tab = activeTab();
    if (!tab) return;
    if (tab.url) navigateTab(tab, tab.url, { push: false });
    else showHome(tab);
  });
  elements.home.addEventListener("click", () => showHome());
  elements.bookmark.addEventListener("click", toggleBookmark);
  $("#library-button").addEventListener("click", () => openLibrary());
  $("#settings-button").addEventListener("click", () => elements.settingsDialog.showModal());
  $("#help-button").addEventListener("click", () => elements.settingsDialog.showModal());
  $("#learn-more-button")?.addEventListener("click", () => elements.settingsDialog.showModal());
  $("#settings-done-button").addEventListener("click", () => elements.settingsDialog.close());
  $("#library-done-button").addEventListener("click", () => elements.libraryDialog.close());
  $("#open-library-from-settings").addEventListener("click", () => {
    elements.settingsDialog.close();
    openLibrary();
  });
  $$(".library-tab").forEach((button) => button.addEventListener("click", () => {
    currentLibrary = button.dataset.library;
    $$(".library-tab").forEach((item) => item.classList.toggle("active", item === button));
    renderLibrary();
  }));
  $("#clear-history-button").addEventListener("click", () => {
    historyItems = [];
    writeStorage(STORAGE.history, historyItems);
    renderLibrary();
    showToast("تاریخچه پاک شد.");
  });

  $("#shortcut-cancel-button").addEventListener("click", () => elements.shortcutDialog.close());
  elements.shortcutForm.addEventListener("submit", (event) => {
    event.preventDefault();
    const title = $("#shortcut-name").value.trim();
    const url = safeWebUrl($("#shortcut-url").value.trim());
    if (!title || !url) {
      showToast("نام و نشانی معتبر وارد کنید.", true);
      return;
    }
    shortcuts = [...shortcuts.filter((item) => item.url !== url.href), { title, url: url.href }].slice(-10);
    writeStorage(STORAGE.shortcuts, shortcuts);
    for (const tab of tabs) {
      $(".home-quicklinks", tab.homeView)?.querySelectorAll(".custom-quicklink").forEach((item) => item.remove());
      renderHomeShortcuts(tab);
    }
    elements.shortcutForm.reset();
    elements.shortcutDialog.close();
    showToast("میان‌بر ذخیره شد.");
  });

  elements.authButton.addEventListener("click", startGoogleLogin);
  $("#setup-login-button")?.addEventListener("click", startGoogleLogin);
  elements.profileButton.addEventListener("click", () => updateProfileMenu(elements.profileMenu.hidden));
  document.addEventListener("click", (event) => {
    if (!elements.profileControl.contains(event.target)) updateProfileMenu(false);
  });
  elements.logout.addEventListener("click", async () => {
    try {
      const response = await fetch("/api/logout", { method: "POST", credentials: "same-origin" });
      if (!response.ok) throw new Error("Logout failed");
      window.location.reload();
    } catch {
      showToast("خروج انجام نشد؛ دوباره تلاش کنید.", true);
    }
  });

  window.addEventListener("message", (event) => {
    const tab = tabs.find((item) => item.iframe.contentWindow === event.source);
    if (!tab || !event.data || event.data.__sepehr !== true) return;
    if (event.data.type === "title" && typeof event.data.url === "string") {
      const title = String(event.data.url).slice(0, 100);
      // The bridge uses the url field for a title event; the tab's destination remains unchanged.
      tab.title = title || safeShortUrl(tab.url);
      renderTabs();
      updateHistoryTitle(tab.url, tab.title);
      return;
    }
    if (event.data.type !== "navigate" || typeof event.data.url !== "string") return;
    const url = safeWebUrl(event.data.url);
    if (!url) return;
    if (event.data.newTab) {
      const newTab = createTab({ activate: true });
      if (newTab) navigateTab(newTab, url.href, { push: true });
    } else {
      navigateTab(tab, url.href, { push: true });
    }
  });

  window.addEventListener("keydown", (event) => {
    const key = event.key.toLowerCase();
    const modifier = event.ctrlKey || event.metaKey;
    if (modifier && key === "l") {
      event.preventDefault();
      elements.addressInput.focus();
      elements.addressInput.select();
    } else if (modifier && key === "t") {
      event.preventDefault();
      createTab({ activate: true });
    } else if (modifier && key === "w") {
      event.preventDefault();
      if (activeTabId) closeTab(activeTabId);
    } else if (modifier && key === "r") {
      event.preventDefault();
      elements.reload.click();
    }
  });
}

async function boot() {
  setupPwaInstall();
  setupEvents();
  renderShelf();
  createTab({ activate: true });
  await refreshSession();
  const params = new URLSearchParams(window.location.search);
  if (params.has("auth") || params.has("source")) {
    window.history.replaceState({}, "", "/");
  }
}

boot();
