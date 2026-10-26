# WCP Print Queue

Violentmonkey userscript for the Barrows OS [Work Centre Planning Board](https://os.barrowsglobal.com/work-centre-planning-board). Farm-aware print queue, miss/tight/blind flags, a 4-week capacity calendar, and local outsource/barred marks. It only reads the board — it never writes dates, runtimes, or planning status.

## Install (auto-updates)

1. Install [Violentmonkey](https://violentmonkey.github.io/) (Tampermonkey works too).
2. In Violentmonkey: **+** → **Install from URL**, then paste **only** this link (not the GitHub repo page):

   **https://cdn.jsdelivr.net/gh/BarrowsAdditive/WCP-PrintQue@main/userscript/bos-print-queue.user.js**

3. Confirm **Install**. After that, Violentmonkey checks `@updateURL` for a newer `@version` and updates on its own.

If you see “Invalid script” with HTML in the error, the URL was wrong (e.g. `github.com/.../WCP-PrintQue` without `cdn.jsdelivr.net` or `raw.githubusercontent.com`). Use the jsDelivr link above.

## How updates work

Every publish must bump `@version` in **both**:

- `userscript/bos-print-queue.user.js`
- `userscript/bos-print-queue.meta.js`

Violentmonkey hits `@updateURL` (the small `.meta.js` header). If the version is newer, it downloads `@downloadURL` (the full `.user.js`).

Typical check interval is about a day. In Violentmonkey you can also open the script → **Check for updates**.

## Repo layout

| File | Role |
| --- | --- |
| `userscript/bos-print-queue.user.js` | The script (install + download URL) |
| `userscript/bos-print-queue.meta.js` | Header only (update check) |
| `userscript/README.md` | Feature notes and farm rules |

The saved Additive Manufacturing HTML export stays out of this repo.
