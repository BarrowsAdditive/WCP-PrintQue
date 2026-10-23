# BOS Print Queue

A Violentmonkey script for the Work Centre Planning Board at `https://os.barrowsglobal.com/work-centre-planning-board`.

It adds a floating queue on top of the Additive Manufacturing tab (and any other work-centre tab). It does not edit ex-factory dates, runtimes, planning status, or anything else on the board.

## Install

1. Install [Violentmonkey](https://violentmonkey.github.io/) in Chrome or Edge. Tampermonkey can load the same file.
2. Open this URL so it can auto-update from GitHub:

   https://raw.githubusercontent.com/BarrowsAdditive/WCP-PrintQue/main/userscript/bos-print-queue.user.js

   Confirm **Install**. Violentmonkey will check `@updateURL` for a newer `@version` after that. To ship a change, bump `@version` in both `bos-print-queue.user.js` and `bos-print-queue.meta.js`, then push to `main`.
3. Open the planning board and select **Additive Manufacturing**. The **Print queue** panel sits on the right. The **Complete** group on the board is collapsed once on first load.
4. Open **Farm settings** and set the real printer count. Until you do, it assumes 6 printers running 20 hours a day. That assumption is what decides which jobs show as missing.
5. Alt+Q collapses the panel. The **⇥** button docks it full-height to the right of the window (WCP shifts left). **Gap from board** in Farm settings is the space between the docked panel and the board; drag the left edge of a docked panel to change its width. Undock with **⇤**, or drag the header when floating. Size and position are remembered.
6. **Expand all rows** opens every planning group (Complete / Planned / Not Planned) and every workticket’s part list on the current board tab. **Collapse all rows** closes them again. This only clicks the board — it does not change BOS data. After expanding, the queue can read part runtimes for sub-queues.
7. Click a job name in the queue to scroll the board to that row (opens its planning group if needed) and **blink** the row yellow a few times. Click **+** on a job card to open the part list in the panel, scroll to the job, and **expand** it on the board so SKUs and runtimes load. Click a **part line** inside an expanded card to jump to that SKU row on the board (same blink).
8. **OS** marks outsourced work for the farm queue only (saved in this browser by workticket). Job **OS** marks the whole job; part **OS** marks one SKU. Orange styling and the OS lens show what is off the farm clock.

## What it is doing

**Time Left on the board is one printer, running without a break.** A job that says `1d 17h left` does not finish tomorrow if several printers can share it, and it does not finish in a day and a half if the farm is already busy.

**Ex factory is the day the unit leaves.** Assembly still has to fit the prints onto the unit, so the script pulls the print deadline forward. The default is 7 days. Change **Days before ex factory** if the floor needs more or less.

Each open row is then placed on a shared farm clock:

- printer-hours = board time, plus a reprint allowance (default 12%)
- farm time = those hours spread across your printers and the hours each one actually runs
- spare time = the print deadline minus when this job would finish after the jobs ahead of it

A row with parts still open and `0m` left is **blind**. It is listed first and kept out of the clock, because a queue built on a zero is a lie. Set a runtime on the board (the existing runtime override) and it will fall into place.

Pre-production rows are held off the printers so an unreleased job does not jump a released one. Turn that off in settings if you do want them in the queue.

## The four orders

- **Save the dates.** Print in ex-factory order. If one long job would make several shorter jobs miss, it is parked with the reason. This is the default.
- **Earliest ex factory.** Strict date order. A long job keeps its place even when it crowds the next one.
- **Tightest slack.** The job with the least spare time, if the whole farm worked on it alone, goes first.
- **Short jobs first.** Clear the short plates, but anything that would already miss on its own stays at the front.

Click a card to jump to that row (it lands in the upper third of the board, not dead-centre). The row gets a thin stripe and one line under the progress bar, for example `#1 · 9h on farm · 2.8d spare`. Comfortable rows can be faded from Farm settings.

Miss, Tight, Blind, and OS at the top of the panel filter the list and jump the list back to the top. The colour chips under those counts are the same tints used on the board.

Each workticket row gets a light tint on the board: **red** miss, **orange** tight, **purple** blind, **pink** outsourced, slate parked/held, soft green when it has spare time. Expanded part rows get the same tints. The panel cards use the same colours.

**Copy handover** puts the current order on the clipboard, including the part order under each job.

## Parts under a job

A kit only leaves Additive when the last in-house SKU is done. All SKUs share the job’s prints-needed-by date, so the sub-queue is not a second due-date sort.

Open the **+** on a job card (and expand the row on the board so runtimes are visible):

1. SKUs with leftover qty and **no runtime** sit at the top. You cannot honestly print what you cannot time.
2. Remaining in-house SKUs are ordered by **remaining printer-hours**, longest first. Starting the long clip run last is how a kit that looked fine still misses.
3. **Miss / tight** on a SKU is that SKU’s farm time measured from this job’s place in the queue, not from now. A part that is fine if the farm is free can still be tight if the job only starts in three days.
4. Short leftover SKUs stay at the bottom.

The gold cue on the card is the SKU to load first.

## Outsourced

**OS** on a job or a SKU is a local mark in this browser. It does not write to BOS.

- A whole job marked OS drops off the farm clock and sits in **Outsourced**. The OS count includes jobs with even one SKU marked OS.
- A single SKU marked OS is pulled out of that job’s remaining hours, so the queue only plans what you are still printing. The OS filter lists that job with **only the outsourced SKUs**, not the in-house ones.
- Unmarking one SKU on a fully-OS job brings just that SKU back in-house and leaves the rest OS.

Use this for work already sent to a vendor, not as a “hide this” switch. If you hide something that is still yours, the dates will look healthier than they are.

## The line under each progress bar

| Line | Meaning |
| --- | --- |
| `#3 · 9h on farm · 2.8d spare` | Place in the queue, real farm time, spare time after the jobs ahead |
| `! · no runtime · 45 pts` | Parts are open and the board has no print time |
| `park · 31d of the farm` | This job is long enough to sink the jobs around it |
| `hold · pre-production` | Not released, so it is not taking a machine |
| `outsourced · 280 pts` | Marked OS here, so it is not taking a printer |
