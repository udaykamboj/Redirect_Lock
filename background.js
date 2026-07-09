// Redirect Lock — background service worker
//
// Two jobs:
//   1. Own the toolbar icon. There is no default_popup — a click just tells
//      the content script on the active tab to open/close the injected UI.
//   2. Keep declarativeNetRequest dynamic rules in sync with whatever is in
//      chrome.storage (locked domain, exceptions, and the block-iframes
//      toggle). Settings persistence lives entirely in storage; this worker
//      never tracks popup-open/closed state — that's the content script's
//      in-memory job only.

const RULE_ID_MAIN_FRAME = 1;
const RULE_ID_SUB_FRAME = 2;

const DEFAULTS = {
  enabled: true,        // master switch (matches "masterSwitch" in the popup)
  domain: "",            // locked domain, e.g. "example.com"
  exceptions: [],         // extra domains that stay reachable
  blockPopups: true,      // toggle1 — window.open()/target=_blank backstop
  blockIframes: false,    // toggle2 — also block off-site iframes
  showNotice: true        // toggle3 — flash a small "blocked" banner
};

// ---------- storage helpers (sync, falling back to local) ----------

let storageArea = null;

async function resolveStorageArea() {
  if (storageArea) return storageArea;
  try {
    // chrome.storage.sync exists but can throw on read/write if sync isn't
    // set up for the profile (e.g. no signed-in account). Probe it once.
    await chrome.storage.sync.get(null);
    storageArea = chrome.storage.sync;
  } catch (_) {
    storageArea = chrome.storage.local;
  }
  return storageArea;
}

async function getSettings() {
  const area = await resolveStorageArea();
  const stored = await area.get(DEFAULTS);
  return { ...DEFAULTS, ...stored };
}

function normalizeDomain(input) {
  if (!input) return "";
  let d = String(input).trim().toLowerCase();
  d = d.replace(/^https?:\/\//, "");
  d = d.replace(/^www\./, "");
  d = d.split("/")[0];
  return d;
}

// ---------- declarativeNetRequest rule sync ----------

async function applyRules() {
  const { enabled, domain, exceptions, blockIframes } = await getSettings();
  const cleanDomain = normalizeDomain(domain);
  const cleanExceptions = (exceptions || [])
    .map(normalizeDomain)
    .filter(Boolean);

  const existing = await chrome.declarativeNetRequest.getDynamicRules();
  const removeIds = existing.map((r) => r.id);

  const addRules = [];

  if (enabled && cleanDomain) {
    const resourceTypes = ["main_frame"];
    if (blockIframes) resourceTypes.push("sub_frame");

    // Only applies to navigations that START on the locked site, and always
    // allows the locked domain itself plus any user-added exceptions.
    addRules.push({
      id: RULE_ID_MAIN_FRAME,
      priority: 1,
      action: { type: "block" },
      condition: {
        initiatorDomains: [cleanDomain],
        excludedRequestDomains: [cleanDomain, ...cleanExceptions],
        resourceTypes
      }
    });
  }

  await chrome.declarativeNetRequest.updateDynamicRules({
    removeRuleIds: removeIds,
    addRules
  });

  // Content scripts read this for their JS-level backup layer
  // (window.open / target=_blank interception, click interception, etc).
  await chrome.storage.local.set({
    activeDomain: enabled ? cleanDomain : "",
    activeExceptions: enabled ? cleanExceptions : []
  });
}

chrome.runtime.onInstalled.addListener(applyRules);
chrome.runtime.onStartup.addListener(applyRules);
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "sync" || area === "local") {
    // Ignore pure bookkeeping keys written by applyRules itself to avoid
    // needless re-runs (activeDomain/activeExceptions live in local only).
    const keys = Object.keys(changes);
    const onlyBookkeeping = keys.every((k) => k === "activeDomain" || k === "activeExceptions");
    if (!onlyBookkeeping) applyRules();
  }
});

// Extra safety net: if a popup/new-tab window somehow gets created before the
// network rule can block its first request (rare race on some platforms),
// close it immediately if it wasn't opened to the locked domain or an
// exception — but only while the "block popups & new tabs" toggle is on.
chrome.tabs.onCreated.addListener(async (tab) => {
  const { enabled, domain, exceptions, blockPopups } = await getSettings();
  if (!enabled || !blockPopups) return;
  const cleanDomain = normalizeDomain(domain);
  if (!cleanDomain) return;
  const cleanExceptions = (exceptions || []).map(normalizeDomain).filter(Boolean);
  if (!tab.openerTabId) return;

  const matchesAllowed = (host) =>
    host === cleanDomain ||
    host.endsWith("." + cleanDomain) ||
    cleanExceptions.some((ex) => host === ex || host.endsWith("." + ex));

  try {
    const opener = await chrome.tabs.get(tab.openerTabId);
    const openerHost = opener.url ? new URL(opener.url).hostname.replace(/^www\./, "") : "";
    if (!matchesAllowed(openerHost)) return;

    setTimeout(async () => {
      try {
        const t = await chrome.tabs.get(tab.id);
        if (!t.url || t.url === "about:blank") return;
        const host = new URL(t.url).hostname.replace(/^www\./, "");
        if (!matchesAllowed(host)) {
          chrome.tabs.remove(tab.id);
        }
      } catch (_) {}
    }, 50);
  } catch (_) {}
});

// ---------- toolbar icon: no default_popup, drive everything via messages ----------

chrome.action.onClicked.addListener(async (tab) => {
  if (!tab || !tab.id) return;
  try {
    await chrome.tabs.sendMessage(tab.id, { type: "RL_TOGGLE_POPUP" });
  } catch (_) {
    // Content script may not be injected yet (e.g. page loaded before the
    // extension did). Fall back to injecting it now, then toggle.
    try {
      await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        files: ["content.js"]
      });
      await chrome.tabs.sendMessage(tab.id, { type: "RL_TOGGLE_POPUP" });
    } catch (_) {
      // Nothing we can do on restricted pages (chrome://, Web Store, etc).
    }
  }
});

// ---------- blocked-navigation feedback for the "show blocked-page notice" toggle ----------
// declarativeNetRequestFeedback only reports matches while the extension is
// unpacked/in developer mode, which matches this extension's install method.
if (chrome.declarativeNetRequest.onRuleMatchedDebug) {
  chrome.declarativeNetRequest.onRuleMatchedDebug.addListener(async (info) => {
    try {
      const { enabled, showNotice } = await getSettings();
      if (!enabled || !showNotice) return;
      const tabId = info && info.request && info.request.tabId;
      if (tabId === undefined || tabId < 0) return;
      chrome.tabs.sendMessage(tabId, { type: "RL_SHOW_BLOCKED_NOTICE" }).catch(() => {});
    } catch (_) {}
  });
}
