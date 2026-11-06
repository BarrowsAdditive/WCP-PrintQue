# WCP Print Queue

Violentmonkey userscript for the Barrows OS [Work Centre Planning Board](https://os.barrowsglobal.com/work-centre-planning-board). Farm-aware print queue, miss/tight/blind flags, a 4-week capacity calendar, and local outsource/barred marks. It only reads the board — it never writes dates, runtimes, or planning status.

## Install (auto-updates)

1. Install [Violentmonkey](https://violentmonkey.github.io/) (Tampermonkey works too).
2. In Violentmonkey: **+** → **Install from URL**, then paste **only** this link (not the GitHub repo page):

   **https://raw.githubusercontent.com/BarrowsAdditive/WCP-PrintQue/main/userscript/bos-print-queue.user.js**

3. Confirm **Install**. After that, Violentmonkey checks `@updateURL` for a newer `@version` and updates on its own.

If you see “Invalid script” with HTML in the error, the URL was wrong (e.g. the GitHub repo homepage). Use the `raw.githubusercontent.com` link above — not `github.com/.../WCP-PrintQue` in the browser.

## How updates work

Every publish must bump `@version` in **both**:

- `userscript/bos-print-queue.user.js`
- `userscript/bos-print-queue.meta.js`

Violentmonkey hits `@updateURL` (the small `.meta.js` header). If the version is newer, it downloads `@downloadURL` (the full `.user.js`). Both URLs point at GitHub raw `main` so updates are not blocked by jsDelivr caching the large `.user.js` on `@main`.

Typical check interval is about a day. In Violentmonkey you can also open the script → **Check for updates**.

## Saving settings and OS/Bar marks

Everything (farm numbers, dock position, outsource and barred marks) is stored in the **browser** (like `localStorage`). A different PC, another browser profile, clearing site data, or strict privacy modes can make it look like the script “forgot”. The panel also writes a **session backup** when local storage is unavailable. For a durable copy you can move between machines, use **Farm settings → Export saved data** / **Import saved data**.

## Repo layout

| File | Role |
| --- | --- |
| `userscript/bos-print-queue.user.js` | The script (install + download URL) |
| `userscript/bos-print-queue.meta.js` | Header only (update check) |
| `userscript/README.md` | Feature notes and farm rules |

The saved Additive Manufacturing HTML export stays out of this repo.
