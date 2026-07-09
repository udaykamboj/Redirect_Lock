// Redirect Lock — content script
//
// Two responsibilities:
//   1. Belt-and-suspenders redirect blocking: neutralizes window.open() and
//      intercepts off-site link clicks on the locked page, backing up the
//      network-layer declarativeNetRequest block in background.js.
//   2. Owns the injected settings UI (Shadow DOM). The toolbar icon has no
//      default_popup — the background worker sends this script a message on
//      every click, and this script toggles the UI open/closed. That
//      open/closed state lives only in an in-memory variable for this page
//      load; it is never written to chrome.storage, so a reload always
//      starts closed. Everything the UI actually edits (locked domain,
//      exceptions, toggle states) IS persisted, via chrome.storage.

(function () {
  "use strict";

  const HOST_ID = "redirect-lock-ext-host";

  // ---------------------------------------------------------------------
  // Storage helpers (sync, falling back to local if sync isn't available)
  // ---------------------------------------------------------------------
  let storageAreaPromise = null;
  function getStorageArea() {
    if (storageAreaPromise) return storageAreaPromise;
    storageAreaPromise = chrome.storage.sync
      .get(null)
      .then(() => chrome.storage.sync)
      .catch(() => chrome.storage.local);
    return storageAreaPromise;
  }

  const SETTINGS_DEFAULTS = {
    enabled: true,
    domain: "",
    exceptions: [],
    blockPopups: true,
    blockIframes: false,
    showNotice: true
  };

  async function readSettings() {
    const area = await getStorageArea();
    const stored = await area.get(SETTINGS_DEFAULTS);
    return Object.assign({}, SETTINGS_DEFAULTS, stored);
  }

  async function writeSettings(patch) {
    const area = await getStorageArea();
    await area.set(patch);
  }

  // ---------------------------------------------------------------------
  // Belt-and-suspenders JS-level redirect blocking (backup to DNR)
  // ---------------------------------------------------------------------
  (async () => {
    let activeDomain = "";
    let activeExceptions = [];
    let blockPopups = true;
    try {
      const local = await chrome.storage.local.get({ activeDomain: "", activeExceptions: [] });
      activeDomain = local.activeDomain || "";
      activeExceptions = local.activeExceptions || [];
      const settings = await readSettings();
      blockPopups = settings.blockPopups;
    } catch (_) {
      return;
    }

    if (!activeDomain || !blockPopups) return;

    const host = location.hostname.replace(/^www\./, "");
    const onLockedSite = host === activeDomain || host.endsWith("." + activeDomain);
    if (!onLockedSite) return;

    function isAllowedTarget(url) {
      try {
        const u = new URL(url, location.href);
        const h = u.hostname.replace(/^www\./, "");
        if (h === activeDomain || h.endsWith("." + activeDomain)) return true;
        return activeExceptions.some((ex) => h === ex || h.endsWith("." + ex));
      } catch (_) {
        return true; // relative/invalid URLs stay allowed; network layer still guards real navigations
      }
    }

    const nativeOpen = window.open;
    window.open = function (url, ...rest) {
      if (url && !isAllowedTarget(url)) return null;
      return nativeOpen.call(window, url, ...rest);
    };

    document.addEventListener(
      "click",
      (e) => {
        const a = e.target && e.target.closest ? e.target.closest("a[href]") : null;
        if (!a) return;
        if (!isAllowedTarget(a.href)) {
          e.preventDefault();
          e.stopPropagation();
        }
      },
      true
    );
  })();

  // ---------------------------------------------------------------------
  // Injected settings UI (Shadow DOM). Markup/CSS below is unchanged from
  // the design file — only the wiring at the bottom is real now instead of
  // in-memory placeholders.
  // ---------------------------------------------------------------------

  let ui = null;       // set once injected: { shadow, popup, launcher, ... }
  let isOpen = false;   // in-memory only — never persisted, resets on reload

  function buildUI() {
    if (document.getElementById(HOST_ID)) return null; // never inject twice

    const host = document.createElement("div");
    host.id = HOST_ID;
    host.style.all = "initial";
    host.style.position = "fixed";
    host.style.top = "0";
    host.style.left = "0";
    host.style.width = "0";
    host.style.height = "0";
    host.style.zIndex = "2147483647"; // max safe z-index, guarantees top stacking
    document.documentElement.appendChild(host);

    const shadow = host.attachShadow({ mode: "open" });

    const style = document.createElement("style");
    style.textContent = `
    :host { all: initial; }

    * { box-sizing: border-box; }

    .rl-root {
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
      -webkit-font-smoothing: antialiased;
      -moz-osx-font-smoothing: grayscale;
      text-rendering: optimizeLegibility;
      color: #16181d;
    }

    .rl-launcher {
      position: fixed;
      top: 28px;
      right: 28px;
      pointer-events: auto;
    }

    #openBtn {
      padding: 12px 22px;
      font-size: 15px;
      font-weight: 600;
      border: none;
      border-radius: 9px;
      background: #2f6fed;
      color: white;
      cursor: pointer;
      box-shadow: 0 8px 20px rgba(20,22,30,0.18);
    }
    #openBtn:hover { background: #2660d6; }

    .popup {
      position: fixed;
      top: 28px;
      right: 28px;
      width: 460px;
      background: #ffffff;
      border-radius: 14px;
      border: 1px solid #e4e6eb;
      box-shadow: 0 20px 45px rgba(20, 22, 30, 0.22);
      overflow: hidden;
      display: none;
      pointer-events: auto;
    }
    .popup.animating {
      transition: top 0.35s cubic-bezier(.2,.7,.3,1), left 0.35s cubic-bezier(.2,.7,.3,1), right 0.35s cubic-bezier(.2,.7,.3,1);
    }

    .popup-head {
      padding: 18px 20px;
      border-bottom: 1px solid #e4e6eb;
      display: flex;
      align-items: center;
      gap: 6px;
      cursor: move;
      user-select: none;
      background: #fafbfc;
    }

    .popup-head h1 {
      font-size: 19px;
      margin: 0;
      font-weight: 700;
      flex: 1;
      letter-spacing: -0.01em;
      line-height: 1;
    }

    .icon-btn {
      background: none;
      border: none;
      color: #5b6270;
      cursor: pointer;
      padding: 6px;
      border-radius: 7px;
      display: flex;
      align-items: center;
      justify-content: center;
    }
    .icon-btn:hover { background: #e4e6eb; color: #16181d; }
    .icon-btn svg { width: 15px; height: 15px; display: block; }

    .popup-close svg { width: 16px; height: 16px; }

    .popup-close { padding: 6px 8px; }

    .popup-body {
      padding: 20px 22px 22px;
      max-height: 74vh;
      overflow-y: auto;
    }

    .status-row {
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: 13px 15px;
      border-radius: 10px;
      background: #e6f6ec;
      margin-bottom: 20px;
    }
    .status-row.off { background: #f1f2f4; }

    .status-text { display: flex; align-items: center; gap: 9px; }

    .status-dot {
      width: 12px;
      height: 12px;
      border-radius: 50%;
      background: #1f9d55;
      flex-shrink: 0;
    }
    .status-row.off .status-dot { background: #9aa0ac; }

    .status-text span { font-size: 15px; font-weight: 600; }
    .status-row.off .status-text span { color: #5b6270; }

    .switch {
      width: 40px;
      height: 23px;
      border-radius: 999px;
      background: #1f9d55;
      position: relative;
      cursor: pointer;
      flex-shrink: 0;
      border: none;
      padding: 0;
    }
    .switch.off { background: #c7cbd3; }
    .switch::after {
      content: "";
      position: absolute;
      top: 2px;
      left: 19px;
      width: 19px;
      height: 19px;
      border-radius: 50%;
      background: white;
      transition: left 0.15s ease;
      box-shadow: 0 1px 2px rgba(0,0,0,0.25);
    }
    .switch.off::after { left: 2px; }

    .section { margin-bottom: 22px; }
    .section:last-child { margin-bottom: 0; }

    .section-title { font-size: 15px; font-weight: 700; margin: 0 0 4px; }
    .section-sub { font-size: 14px; line-height: 1.45; color: #5b6270; margin: 0 0 11px; }

    .input-row { display: flex; gap: 8px; align-items: flex-start; }
    .input-wrap { flex: 1; }

    .text-input {
      width: 100%;
      padding: 11px 13px;
      border: 1.5px solid #e4e6eb;
      border-radius: 9px;
      font-size: 14px;
      color: #16181d;
      outline: none;
      font-family: inherit;
    }
    .text-input:focus { border-color: #2f6fed; }
    .text-input.error { border-color: #d64545; background: #fdecec; }

    .error-msg { font-size: 14px; color: #d64545; margin: 6px 0 0; display: none; }
    .error-msg.show { display: block; }

    .btn {
      padding: 11px 18px;
      border-radius: 9px;
      font-size: 14.5px;
      font-weight: 600;
      border: 1.5px solid #e4e6eb;
      background: #ffffff;
      color: #16181d;
      cursor: pointer;
      white-space: nowrap;
      font-family: inherit;
    }
    .btn:hover { background: #f4f5f7; }

    .btn.primary { background: #2f6fed; border-color: #2f6fed; color: white; }
    .btn.primary:hover { background: #2660d6; }

    .current-domain {
      display: none;
      align-items: center;
      gap: 8px;
      padding: 10px 13px;
      border: 1.5px solid #e4e6eb;
      border-radius: 9px;
      margin-top: 10px;
      font-size: 14px;
      color: #5b6270;
    }
    .current-domain.show { display: flex; }
    .current-domain strong { color: #16181d; font-weight: 700; }

    .chip-list { display: flex; flex-wrap: wrap; gap: 7px; margin-top: 12px; }
    .chip {
      display: flex;
      align-items: center;
      gap: 7px;
      padding: 7px 11px;
      background: #eaf1ff;
      color: #2f6fed;
      border-radius: 999px;
      font-size: 13.5px;
      font-weight: 600;
    }
    .chip button {
      border: none;
      background: none;
      color: #2f6fed;
      cursor: pointer;
      font-size: 14px;
      line-height: 1;
      padding: 0;
      opacity: 0.65;
    }
    .chip button:hover { opacity: 1; }

    .toggle-row {
      display: flex;
      align-items: flex-start;
      justify-content: space-between;
      gap: 16px;
      padding: 14px 0;
      border-top: 1px solid #e4e6eb;
    }
    .toggle-row:first-of-type { border-top: none; padding-top: 0; }
    .toggle-copy strong { display: block; font-size: 15px; margin-bottom: 3px; }
    .toggle-copy span { font-size: 14px; line-height: 1.45; color: #5b6270; }

    .popup-foot {
      border-top: 1px solid #e4e6eb;
      padding: 16px 22px;
      display: flex;
      justify-content: flex-end;
      align-items: center;
      gap: 10px;
    }

    .saved-note {
      font-size: 13px;
      color: #1f9d55;
      font-weight: 600;
      margin-right: auto;
      opacity: 0;
      transition: opacity 0.2s ease;
    }
    .saved-note.show { opacity: 1; }
  `;
    shadow.appendChild(style);

    const root = document.createElement("div");
    root.className = "rl-root";
    root.innerHTML = `
    <div class="rl-launcher" id="launcher">
      <button id="openBtn">Open Redirect Lock</button>
    </div>

    <div class="popup" id="popup">
      <div class="popup-head" id="popupHeader">
        <h1>Redirect Lock</h1>
        <button class="icon-btn" id="resetPosBtn" aria-label="Reset window position" title="Reset position">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <path d="M3 3v6h6"></path>
            <path d="M3 9a9 9 0 1 1 2.6 6.4"></path>
          </svg>
        </button>
        <button class="icon-btn popup-close" id="closeBtn" aria-label="Close" title="Close">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <path d="M18 6 6 18"></path>
            <path d="M6 6l12 12"></path>
          </svg>
        </button>
      </div>

      <div class="popup-body">
        <div class="status-row" id="statusRow">
          <div class="status-text">
            <span class="status-dot"></span>
            <span id="statusText">Protection active</span>
          </div>
          <button class="switch" id="masterSwitch" aria-label="Toggle protection"></button>
        </div>

        <div class="section">
          <p class="section-title">Locked domain</p>
          <p class="section-sub">Only this domain (and its subdomains) can be navigated to.</p>
          <div class="input-row">
            <div class="input-wrap">
              <input class="text-input" id="domainInput" type="text" placeholder="e.g. example.com">
              <p class="error-msg" id="domainError">Enter a valid domain, like example.com</p>
            </div>
            <button class="btn primary" id="saveDomainBtn">Save</button>
          </div>
          <div class="current-domain" id="currentDomain">
            Currently locked to <strong id="currentDomainText"></strong>
          </div>
        </div>

        <div class="section">
          <p class="section-title">Allowed exceptions</p>
          <p class="section-sub">Domains that are still reachable even though they're outside the locked site.</p>
          <div class="input-row">
            <div class="input-wrap">
              <input class="text-input" id="exceptionInput" type="text" placeholder="Add a domain to allow">
              <p class="error-msg" id="exceptionError">Enter a valid domain, like accounts.google.com</p>
            </div>
            <button class="btn" id="addExceptionBtn">Add</button>
          </div>
          <div class="chip-list" id="chipList"></div>
        </div>

        <div class="section">
          <div class="toggle-row">
            <div class="toggle-copy">
              <strong>Block popups &amp; new tabs</strong>
              <span>Prevents any window.open() or target=_blank navigation off-site.</span>
            </div>
            <button class="switch" id="toggle1"></button>
          </div>
          <div class="toggle-row">
            <div class="toggle-copy">
              <strong>Block iframe embeds</strong>
              <span>Also blocks off-site content loaded inside iframes, like embedded video or ads.</span>
            </div>
            <button class="switch off" id="toggle2"></button>
          </div>
          <div class="toggle-row">
            <div class="toggle-copy">
              <strong>Show a blocked-page notice</strong>
              <span>Briefly flashes a small banner when a redirect is stopped.</span>
            </div>
            <button class="switch" id="toggle3"></button>
          </div>
        </div>
      </div>

      <div class="popup-foot">
        <span class="saved-note" id="savedNote">Saved</span>
        <button class="btn" id="resetBtn">Reset</button>
        <button class="btn primary" id="saveChangesBtn">Save changes</button>
      </div>
    </div>
  `;
    shadow.appendChild(root);

    // ---------- Element refs ----------
    const $ = (id) => shadow.getElementById(id);

    const launcher = $("launcher");
    const popup = $("popup");
    const header = $("popupHeader");
    const openBtn = $("openBtn");
    const closeBtn = $("closeBtn");
    const resetPosBtn = $("resetPosBtn");

    const HOME_TOP = "28px";
    const HOME_RIGHT = "28px";

    function setOpenState(open) {
      isOpen = open;
      popup.style.display = open ? "block" : "none";
      launcher.style.display = open ? "none" : "block";
    }

    openBtn.addEventListener("click", () => setOpenState(true));
    closeBtn.addEventListener("click", () => setOpenState(false));

    // ---------- Reset position with smooth animation ----------
    resetPosBtn.addEventListener("click", () => {
      popup.classList.add("animating");
      popup.style.left = "auto";
      popup.style.top = HOME_TOP;
      popup.style.right = HOME_RIGHT;
      const clear = () => {
        popup.classList.remove("animating");
        popup.removeEventListener("transitionend", clear);
      };
      popup.addEventListener("transitionend", clear);
    });

    // ---------- Domain validation ----------
    const DOMAIN_RE = /^(?!-)[a-z0-9-]{1,63}(?<!-)(\.(?!-)[a-z0-9-]{1,63}(?<!-))*\.[a-z]{2,}$/i;

    function isValidDomain(value) {
      const v = value.trim().toLowerCase();
      if (!v || v.length > 253) return false;
      if (/^[a-z]+:\/\//i.test(v) || /[\/\s?#]/.test(v)) return false;
      return DOMAIN_RE.test(v);
    }

    function wireValidatedInput(input, errorEl) {
      input.addEventListener("input", () => {
        input.classList.remove("error");
        errorEl.classList.remove("show");
      });
    }

    // ---------- Locked domain ----------
    const domainInput = $("domainInput");
    const domainError = $("domainError");
    const saveDomainBtn = $("saveDomainBtn");
    const currentDomain = $("currentDomain");
    const currentDomainText = $("currentDomainText");

    wireValidatedInput(domainInput, domainError);

    function showLockedDomain(value) {
      if (value) {
        currentDomainText.textContent = value;
        currentDomain.classList.add("show");
        domainInput.placeholder = value;
      } else {
        currentDomainText.textContent = "";
        currentDomain.classList.remove("show");
        domainInput.placeholder = "e.g. example.com";
      }
    }

    saveDomainBtn.addEventListener("click", async () => {
      const value = domainInput.value.trim().toLowerCase();
      if (!isValidDomain(value)) {
        domainInput.classList.add("error");
        domainError.classList.add("show");
        return;
      }
      domainInput.classList.remove("error");
      domainError.classList.remove("show");
      await writeSettings({ domain: value });
      showLockedDomain(value);
      domainInput.value = "";
      flashSaved();
    });

    domainInput.addEventListener("keydown", (e) => {
      if (e.key === "Enter") saveDomainBtn.click();
    });

    // ---------- Exceptions ----------
    const exceptionInput = $("exceptionInput");
    const exceptionError = $("exceptionError");
    const addExceptionBtn = $("addExceptionBtn");
    const chipList = $("chipList");

    wireValidatedInput(exceptionInput, exceptionError);

    function currentChipValues() {
      return Array.from(chipList.children).map((chip) =>
        chip.getAttribute("data-domain")
      );
    }

    function addChip(value) {
      const chip = document.createElement("div");
      chip.className = "chip";
      chip.setAttribute("data-domain", value);
      const label = document.createTextNode(value + " ");
      const removeBtn = document.createElement("button");
      removeBtn.textContent = "\u2715";
      removeBtn.setAttribute("aria-label", "Remove " + value);
      removeBtn.addEventListener("click", async () => {
        chip.remove();
        await writeSettings({ exceptions: currentChipValues() });
        flashSaved();
      });
      chip.appendChild(label);
      chip.appendChild(removeBtn);
      chipList.appendChild(chip);
    }

    function renderChips(list) {
      chipList.innerHTML = "";
      (list || []).forEach(addChip);
    }

    addExceptionBtn.addEventListener("click", async () => {
      const value = exceptionInput.value.trim().toLowerCase();
      if (!isValidDomain(value)) {
        exceptionInput.classList.add("error");
        exceptionError.textContent = "Enter a valid domain, like accounts.google.com";
        exceptionError.classList.add("show");
        return;
      }
      const existing = currentChipValues().includes(value);
      if (existing) {
        exceptionInput.classList.add("error");
        exceptionError.textContent = "That domain is already in the list";
        exceptionError.classList.add("show");
        return;
      }
      exceptionInput.classList.remove("error");
      exceptionError.classList.remove("show");
      addChip(value);
      await writeSettings({ exceptions: currentChipValues() });
      exceptionInput.value = "";
      flashSaved();
    });

    exceptionInput.addEventListener("keydown", (e) => {
      if (e.key === "Enter") addExceptionBtn.click();
    });

    // ---------- Master toggle ----------
    const masterSwitch = $("masterSwitch");
    const statusRow = $("statusRow");
    const statusText = $("statusText");

    function setMasterUI(enabled) {
      masterSwitch.classList.toggle("off", !enabled);
      statusRow.classList.toggle("off", !enabled);
      statusText.textContent = enabled ? "Protection active" : "Protection paused";
    }

    masterSwitch.addEventListener("click", async () => {
      const nowEnabled = masterSwitch.classList.contains("off"); // about to turn on
      setMasterUI(nowEnabled);
      await writeSettings({ enabled: nowEnabled });
      flashSaved();
    });

    // ---------- toggle1 / toggle2 / toggle3 ----------
    const TOGGLE_KEYS = {
      toggle1: "blockPopups",
      toggle2: "blockIframes",
      toggle3: "showNotice"
    };

    function setToggleUI(id, on) {
      $(id).classList.toggle("off", !on);
    }

    Object.keys(TOGGLE_KEYS).forEach((id) => {
      $(id).addEventListener("click", async () => {
        const el = $(id);
        const nowOn = el.classList.contains("off"); // about to turn on
        setToggleUI(id, nowOn);
        await writeSettings({ [TOGGLE_KEYS[id]]: nowOn });
        flashSaved();
      });
    });

    // ---------- Reset / Save changes ----------
    const resetBtn = $("resetBtn");
    const saveChangesBtn = $("saveChangesBtn");
    const savedNote = $("savedNote");

    let savedTimer = null;
    function flashSaved() {
      savedNote.classList.add("show");
      clearTimeout(savedTimer);
      savedTimer = setTimeout(() => savedNote.classList.remove("show"), 1600);
    }

    resetBtn.addEventListener("click", async () => {
      domainInput.value = "";
      domainInput.classList.remove("error");
      domainError.classList.remove("show");
      showLockedDomain("");

      exceptionInput.value = "";
      exceptionInput.classList.remove("error");
      exceptionError.classList.remove("show");
      renderChips([]);

      setMasterUI(SETTINGS_DEFAULTS.enabled);
      setToggleUI("toggle1", SETTINGS_DEFAULTS.blockPopups);
      setToggleUI("toggle2", SETTINGS_DEFAULTS.blockIframes);
      setToggleUI("toggle3", SETTINGS_DEFAULTS.showNotice);

      await writeSettings({
        domain: SETTINGS_DEFAULTS.domain,
        exceptions: SETTINGS_DEFAULTS.exceptions,
        enabled: SETTINGS_DEFAULTS.enabled,
        blockPopups: SETTINGS_DEFAULTS.blockPopups,
        blockIframes: SETTINGS_DEFAULTS.blockIframes,
        showNotice: SETTINGS_DEFAULTS.showNotice
      });
      flashSaved();
    });

    saveChangesBtn.addEventListener("click", () => {
      // Toggle/domain/exception writes above already commit immediately on
      // each interaction; this just gives the explicit confirmation the
      // design calls for.
      flashSaved();
    });

    // ---------- Dragging ----------
    let isDragging = false;
    let offsetX = 0;
    let offsetY = 0;

    header.addEventListener("mousedown", (e) => {
      if (e.target === closeBtn || e.target === resetPosBtn || resetPosBtn.contains(e.target) || closeBtn.contains(e.target)) return;
      isDragging = true;
      popup.classList.remove("animating");
      const rect = popup.getBoundingClientRect();
      offsetX = e.clientX - rect.left;
      offsetY = e.clientY - rect.top;
      popup.style.left = rect.left + "px";
      popup.style.top = rect.top + "px";
      popup.style.right = "auto";
    });

    document.addEventListener("mousemove", (e) => {
      if (!isDragging) return;
      popup.style.left = (e.clientX - offsetX) + "px";
      popup.style.top = (e.clientY - offsetY) + "px";
    });

    document.addEventListener("mouseup", () => {
      isDragging = false;
    });

    // ---------- Populate from real stored state (no placeholder values) ----------
    async function hydrate() {
      const settings = await readSettings();
      showLockedDomain(settings.domain || "");
      renderChips(settings.exceptions || []);
      setMasterUI(settings.enabled);
      setToggleUI("toggle1", settings.blockPopups);
      setToggleUI("toggle2", settings.blockIframes);
      setToggleUI("toggle3", settings.showNotice);
    }

    return { shadow, host, popup, launcher, setOpenState, hydrate };
  }

  // ---------------------------------------------------------------------
  // Toggle entry point — driven by the toolbar icon via background.js.
  // Popup open/closed lives only in the `isOpen` variable above; it resets
  // to closed on every fresh page load/navigation since this whole script
  // (and its module state) is re-evaluated then.
  // ---------------------------------------------------------------------
  async function toggleFromIcon() {
    if (!ui) {
      ui = buildUI();
      if (!ui) return; // guarded against double-injection (HOST_ID already present)
      await ui.hydrate();
      ui.setOpenState(true);
      return;
    }
    ui.setOpenState(!isOpen);
  }

  // ---------------------------------------------------------------------
  // Minimal "blocked" banner for the showNotice toggle. This is a small,
  // separate, self-contained element (not part of the popup markup above)
  // since the design file didn't include a banner of its own.
  // ---------------------------------------------------------------------
  function flashBlockedBanner() {
    const id = "redirect-lock-ext-banner-host";
    if (document.getElementById(id)) return;
    const bannerHost = document.createElement("div");
    bannerHost.id = id;
    bannerHost.style.all = "initial";
    bannerHost.style.position = "fixed";
    bannerHost.style.top = "0";
    bannerHost.style.left = "0";
    bannerHost.style.width = "0";
    bannerHost.style.height = "0";
    bannerHost.style.zIndex = "2147483647";
    document.documentElement.appendChild(bannerHost);
    const shadow = bannerHost.attachShadow({ mode: "open" });
    shadow.innerHTML = `
      <style>
        .banner {
          position: fixed;
          bottom: 24px;
          left: 50%;
          transform: translateX(-50%) translateY(10px);
          background: #16181d;
          color: #fff;
          font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
          font-size: 13px;
          font-weight: 600;
          padding: 10px 16px;
          border-radius: 999px;
          opacity: 0;
          transition: opacity 0.2s ease, transform 0.2s ease;
          box-shadow: 0 8px 20px rgba(0,0,0,0.25);
        }
        .banner.show { opacity: 1; transform: translateX(-50%) translateY(0); }
      </style>
      <div class="banner" id="b">Redirect blocked</div>
    `;
    const el = shadow.getElementById("b");
    requestAnimationFrame(() => el.classList.add("show"));
    setTimeout(() => {
      el.classList.remove("show");
      setTimeout(() => bannerHost.remove(), 250);
    }, 1800);
  }

  // ---------------------------------------------------------------------
  // Messages from background.js
  // ---------------------------------------------------------------------
  chrome.runtime.onMessage.addListener((msg) => {
    if (!msg) return;
    if (msg.type === "RL_TOGGLE_POPUP") {
      toggleFromIcon();
    } else if (msg.type === "RL_SHOW_BLOCKED_NOTICE") {
      flashBlockedBanner();
    }
  });
})();
