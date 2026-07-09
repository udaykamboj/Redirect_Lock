# Redirect Lock

Locks one website so that no ad/popup/JS redirect can send the browser to any other domain. Blocking happens at Chrome's native network layer (`declarativeNetRequest`), so there's no delay — the outside request is blocked before it ever starts loading, not after.

## Install (unpacked, works in Chrome / Edge / Brave)

1. Download and unzip this folder somewhere permanent (don't delete it after — Chrome loads the extension from this folder).
2. Go to `chrome://extensions`.
3. Turn on **Developer mode** (top-right toggle).
4. Click **Load unpacked** and select this folder.
5. Click the extension's icon in the toolbar. This opens the settings panel directly on top of the current page — there's no separate popup window. Type in the locked domain (e.g. `example.com`, no `https://` or `www.`) and hit **Save**.

While you're on that site (or any subdomain of it), every link, popup, or script trying to send you to a *different* domain gets blocked. Navigating within the site itself, and typing a new URL into the address bar yourself, both still work normally.

## How the popup works

There's no `default_popup` in the manifest. Clicking the toolbar icon sends a message to a content script already running on the page, which injects (or toggles) the settings panel into an isolated Shadow DOM, so it never clashes with the host page's styles. Click the icon again (or the panel's own close button) to close it.

The panel's open/closed state is **not** saved anywhere — every fresh page load or navigation starts with it closed. Only clicking the icon reopens it.

## What persists

Everything you actually configure in the panel is saved via `chrome.storage.sync` (falling back to `chrome.storage.local` if sync isn't available on your profile), and reloads with real values every time you reopen it:

- Locked domain
- Allowed exceptions
- Block popups & new tabs (on by default)
- Block iframe embeds (off by default)
- Show a blocked-page notice (on by default)
- Overall protection on/off

## What it blocks

- Ad redirects / "malvertising" pop-unders
- `window.open()` popups to other domains
- New tabs opened by JS to other domains
- Meta-refresh / `location.href` redirects to other domains

## What it does NOT block

- Links within the locked domain (that's intended — you can still browse the site itself)
- You manually typing a different URL in the address bar
- Domains you've explicitly added to the exceptions list
- Embedded iframes to other domains — unless "Block iframe embeds" is turned on, which is off by default because it can break legitimate embedded content

## Notes

- The "Show a blocked-page notice" banner relies on `declarativeNetRequestFeedback`, which Chrome only reports for unpacked/developer-mode extensions — matching this extension's install method.
- Works per-browser-profile; settings sync across your signed-in Chrome browsers via `chrome.storage.sync` when available.
