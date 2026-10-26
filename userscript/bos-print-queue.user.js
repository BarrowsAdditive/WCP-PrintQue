// ==UserScript==
// @name         BOS Print Queue
// @namespace    bos.print.queue
// @version      1.3.2
// @description  Farm-aware print queue, jeopardy flags, and early warnings on the Work Centre Planning Board. Reads the board only — it never edits dates, runtimes, or planning status.
// @author       Barrows Additive
// @license      MIT
// @homepageURL  https://github.com/BarrowsAdditive/WCP-PrintQue
// @supportURL   https://github.com/BarrowsAdditive/WCP-PrintQue/issues
// @match        https://os.barrowsglobal.com/*
// @run-at       document-start
// @grant        none
// @installURL   https://cdn.jsdelivr.net/gh/BarrowsAdditive/WCP-PrintQue@main/userscript/bos-print-queue.user.js
// @downloadURL  https://cdn.jsdelivr.net/gh/BarrowsAdditive/WCP-PrintQue@main/userscript/bos-print-queue.user.js
// @updateURL    https://cdn.jsdelivr.net/gh/BarrowsAdditive/WCP-PrintQue@main/userscript/bos-print-queue.meta.js
// ==/UserScript==
(function () {
  "use strict";
  if (window.__bosqLoaded) return;
  window.__bosqLoaded = true;

  const STORAGE_KEY = "bosq-settings-v1";
  const OUTSOURCE_KEY = "bosq-outsourced-v1";
  const BARRED_KEY = "bosq-barred-v1";

  /* BOSQ_PURE_START */
  const MONTHS = { jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5, jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11 };

  function parseBoardDate(text) {
    if (!text) return null;
    const named = String(text).match(/([A-Za-z]{3,9})\s+(\d{1,2}),?\s+(\d{4})/);
    if (named) {
      const month = MONTHS[named[1].slice(0, 3).toLowerCase()];
      if (month != null) return new Date(Number(named[3]), month, Number(named[2]), 16, 0, 0, 0);
    }
    const iso = String(text).match(/(\d{4})-(\d{2})-(\d{2})/);
    if (iso) return new Date(Number(iso[1]), Number(iso[2]) - 1, Number(iso[3]), 16, 0, 0, 0);
    return null;
  }

  function parseDuration(text) {
    if (!text) return 0;
    let sec = 0;
    let any = false;
    const re = /(\d+)\s*([dhm])/gi;
    let m;
    const src = String(text);
    while ((m = re.exec(src))) {
      any = true;
      const n = Number(m[1]);
      const u = m[2].toLowerCase();
      if (u === "d") sec += n * 86400;
      else if (u === "h") sec += n * 3600;
      else sec += n * 60;
    }
    return any ? sec : 0;
  }

  function parseProgress(text) {
    const src = String(text || "").replace(/\s+/g, " ");
    const parts = src.match(/([\d,]+)\s*parts left/i);
    const time = src.match(/\|\s*(.*?)\s*left/i);
    return {
      partsLeft: parts ? Number(parts[1].replace(/,/g, "")) : null,
      boardSeconds: time ? parseDuration(time[1]) : null,
    };
  }

  function addCapacity(startMs, capacityDays, weekends) {
    if (!(capacityDays > 0)) return startMs;
    if (weekends) return startMs + capacityDays * 86400000;
    let ms = startMs;
    let left = capacityDays;
    let guard = 0;
    while (left > 1e-8 && guard++ < 20000) {
      const date = new Date(ms);
      const dow = date.getDay();
      if (dow === 0 || dow === 6) {
        ms = new Date(date.getFullYear(), date.getMonth(), date.getDate() + 1).getTime();
        continue;
      }
      const dayStart = new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
      const room = 1 - (ms - dayStart) / 86400000;
      if (room <= 1e-8) {
        ms = dayStart + 86400000;
        continue;
      }
      const take = Math.min(left, room);
      ms += take * 86400000;
      left -= take;
    }
    return ms;
  }

  function materialFamily(name) {
    const s = String(name || "").toUpperCase();
    if (!s || s === "—" || s === "-" || s === "N/A") return "";
    if (s.includes("PETG")) return "PETG";
    if (s.includes("PLA")) return "PLA";
    if (s.includes("ABS")) return "ABS";
    if (s.includes("ASA")) return "ASA";
    if (s.includes("TPU") || s.includes("FLEX")) return "TPU";
    if (s.includes("NYLON") || s.includes("PA12") || s.includes("PA6")) return "Nylon";
    if (s.includes("RESIN")) return "Resin";
    return String(name).trim();
  }

  function capacityDaysFor(machineHours, longestPartHours, settings) {
    const daily = Math.max(0.25, settings.machines * settings.hoursPerDay);
    let days = machineHours / daily;
    if (longestPartHours > 0) {
      const floor = longestPartHours / Math.max(0.25, settings.hoursPerDay);
      if (floor > days) days = floor;
    }
    return days;
  }

  function scheduleSequence(jobs, settings, now) {
    let cursor = now;
    return jobs.map((job) => {
      const finish = addCapacity(cursor, job.capacityDays, settings.weekends);
      const queued = { ...job, start: cursor, finish, queueSlackDays: (job.needBy.getTime() - finish) / 86400000 };
      cursor = finish;
      return queued;
    });
  }

  function byNeed(a, b) {
    const d = a.needBy - b.needBy;
    if (d) return d;
    return a.machineHours - b.machineHours;
  }

  function saveTheDates(jobs, settings, now) {
    const pool = jobs.slice().sort(byNeed);
    const parked = [];
    for (let guard = 0; guard < pool.length + 3; guard++) {
      const sch = scheduleSequence(pool, settings, now);
      const lateIdx = sch.findIndex((j) => j.queueSlackDays < -0.02);
      if (lateIdx < 0) return { printed: sch, parked };
      let worst = 0;
      for (let i = 1; i <= lateIdx; i++) {
        if (sch[i].machineHours > sch[worst].machineHours) worst = i;
      }
      const [removed] = pool.splice(worst, 1);
      parked.push(removed);
      if (!pool.length) break;
    }
    return { printed: scheduleSequence(pool, settings, now), parked };
  }

  function orderForStrategy(jobs, settings) {
    const list = jobs.slice();
    if (settings.strategy === "slack") {
      list.sort((a, b) => a.aloneSlackDays - b.aloneSlackDays || a.needBy - b.needBy);
      return { printed: list, parked: [] };
    }
    if (settings.strategy === "short") {
      list.sort((a, b) => {
        const aHot = a.aloneSlackDays <= 0 ? 0 : 1;
        const bHot = b.aloneSlackDays <= 0 ? 0 : 1;
        if (aHot !== bHot) return aHot - bHot;
        if (aHot === 0) return a.needBy - b.needBy;
        return a.machineHours - b.machineHours || a.needBy - b.needBy;
      });
      return { printed: list, parked: [] };
    }
    if (settings.strategy === "edd") {
      list.sort(byNeed);
      return { printed: list, parked: [] };
    }
    return null;
  }

  function partKey(name) {
    return String(name || "").trim().toUpperCase();
  }

  function inHouseOpen(job) {
    return (job.parts || []).filter((part) => part.left > 0 && !part.outsourced && !part.barred);
  }

  function farmLoad(job) {
    const house = inHouseOpen(job);
    const fromParts = house.reduce((sum, part) => sum + part.left * (part.runtimeSec || 0), 0);
    const longest = house.reduce((max, part) => Math.max(max, (part.runtimeSec || 0) / 3600), 0);
    const qty = house.reduce((sum, part) => sum + part.left, 0);
    const unrated = house.filter((part) => !(part.runtimeSec > 0)).length;
    const openAll = (job.parts || []).filter((part) => part.left > 0);
    const outQty = openAll.filter((part) => part.outsourced).reduce((sum, part) => sum + part.left, 0);
    const barQty = openAll.filter((part) => part.barred).reduce((sum, part) => sum + part.left, 0);
    if (job.outsourcedJob || job.barredJob || (openAll.length > 0 && house.length === 0)) {
      return { seconds: 0, qty: 0, longest: 0, unrated: 0, outQty, barQty, fullyOut: true, hasParts: openAll.length > 0 };
    }
    if (house.length) {
      return { seconds: fromParts, qty, longest, unrated, outQty, barQty, fullyOut: false, hasParts: true };
    }
    const seconds = job.boardSeconds > 0 ? job.boardSeconds : job.partMachineSeconds || 0;
    return {
      seconds,
      qty: job.partsLeft || 0,
      longest: job.longestPartHours || 0,
      unrated: job.unratedParts || 0,
      outQty: 0,
      barQty: 0,
      fullyOut: false,
      hasParts: false,
    };
  }

  function fullyOutBucket(job, load) {
    if (job.barredJob) return "barred";
    if (job.outsourcedJob) return "outsourced";
    if (load.barQty > 0 && load.outQty === 0) return "barred";
    if (load.outQty > 0) return "outsourced";
    return "barred";
  }

  function decorate(job, settings, now) {
    const load = farmLoad(job);
    const recovered = load.hasParts && !(job.boardSeconds > 0) && load.seconds > 0;
    const machineHours = (load.seconds / 3600) * (1 + settings.scrap);
    const capacityDays = capacityDaysFor(machineHours, load.longest || 0, settings);
    const aloneFinish = addCapacity(now, capacityDays, settings.weekends);
    const aloneSlackDays = job.needBy ? (job.needBy.getTime() - aloneFinish) / 86400000 : null;
    return {
      ...job,
      machineHours,
      capacityDays,
      aloneFinish,
      aloneSlackDays,
      recovered,
      usedSeconds: load.seconds,
      farmQty: load.qty,
      unratedParts: load.unrated,
      outQty: load.outQty,
      barQty: load.barQty,
      fullyOut: load.fullyOut,
      longestPartHours: load.longest,
    };
  }

  function rankParts(job, settings, now) {
    const start = job.start || now;
    const open = (job.parts || []).filter((part) => part.left > 0);
    const houseHours = open
      .filter((part) => !part.outsourced && !part.barred && part.runtimeSec > 0)
      .reduce((sum, part) => sum + (part.left * part.runtimeSec / 3600) * (1 + settings.scrap), 0);
    const scored = open.map((part) => {
      const hours = (part.left * (part.runtimeSec || 0) / 3600) * (1 + settings.scrap);
      const serialHours = (part.runtimeSec || 0) / 3600;
      const capDays = capacityDaysFor(hours, serialHours, settings);
      const finish = addCapacity(start, capDays, settings.weekends);
      const slack = job.needBy ? (job.needBy.getTime() - finish) / 86400000 : null;
      const share = houseHours > 0 && hours > 0 ? hours / houseHours : 0;
      let band = "ok";
      if (part.barred) band = "barred";
      else if (part.outsourced) band = "outsourced";
      else if (!(part.runtimeSec > 0)) band = "blind";
      else if (slack != null && slack < -0.02) band = "late";
      else if (slack != null && slack < settings.tightDays) band = "tight";
      return { ...part, hours, serialHours, capDays, slack, share, band, first: false, order: null };
    });
    const rank = { blind: 0, late: 1, tight: 2, ok: 3, outsourced: 4, barred: 4 };
    scored.sort((a, b) => {
      const d = (rank[a.band] ?? 9) - (rank[b.band] ?? 9);
      if (d) return d;
      return b.hours - a.hours || b.serialHours - a.serialHours || String(a.name).localeCompare(String(b.name));
    });
    let n = 0;
    scored.forEach((part) => {
      if (part.band === "outsourced" || part.band === "barred" || part.band === "blind") return;
      part.order = ++n;
      if (n === 1) part.first = true;
    });
    return scored;
  }

  function partCue(queue) {
    if (!queue || !queue.length) return "";
    const first = queue.find((part) => part.first);
    const blind = queue.filter((part) => part.band === "blind").length;
    const late = queue.filter((part) => part.band === "late").length;
    const tight = queue.filter((part) => part.band === "tight").length;
    const out = queue.filter((part) => part.band === "outsourced").length;
    const barred = queue.filter((part) => part.band === "barred").length;
    const bits = [];
    if (first) bits.push(`Print first: ${first.name}`);
    else if (blind) bits.push("Set a runtime on the open SKUs");
    if (late) bits.push(`${late} miss`);
    if (tight) bits.push(`${tight} tight`);
    if (blind) bits.push(`${blind} blind`);
    if (out) bits.push(`${out} OS`);
    if (barred) bits.push(`${barred} bar`);
    return bits.join(" · ");
  }

  function attachParts(job, settings, now) {
    const partQueue = rankParts(job, settings, now);
    const materials = new Map();
    partQueue.forEach((part) => {
      if (part.outsourced || part.barred || !part.family || !(part.hours > 0)) return;
      materials.set(part.family, (materials.get(part.family) || 0) + part.hours);
    });
    return {
      ...job,
      partQueue,
      partCue: partCue(partQueue),
      materials: [...materials.entries()].map(([family, hours]) => ({ family, hours })),
    };
  }

  function bandForSlack(slack, tightDays) {
    if (slack < -0.02) return "late";
    if (slack < tightDays) return "tight";
    return "ok";
  }

  function buildPlan(rawJobs, settings, nowMs) {
    const now = nowMs == null ? Date.now() : nowMs;
    const bufferMs = settings.bufferDays * 86400000;
    const prepared = rawJobs.map((job) => {
      const ex = job.exFactory;
      const needBy = ex ? new Date(ex.getTime() - bufferMs) : null;
      return { ...job, needBy };
    });

    const done = [];
    const blind = [];
    let held = [];
    const nodate = [];
    const outsourced = [];
    const barred = [];
    const active = [];

    for (const job of prepared) {
      const load = farmLoad(job);
      if (load.fullyOut) {
        const offFarm = {
          ...job,
          machineHours: 0,
          capacityDays: 0,
          usedSeconds: 0,
          farmQty: 0,
          outQty: load.outQty,
          barQty: load.barQty,
          fullyOut: true,
        };
        const bucket = fullyOutBucket(job, load);
        if (bucket === "barred") {
          barred.push(attachParts({ ...offFarm, band: "barred" }, settings, now));
        } else {
          outsourced.push(attachParts({ ...offFarm, band: "outsourced" }, settings, now));
        }
        continue;
      }
      if (job.partsLeft == null && !load.hasParts) {
        nodate.push({ ...job, band: "nodate" });
        continue;
      }
      const remaining = load.hasParts ? load.qty : job.partsLeft;
      if (!(remaining > 0)) {
        done.push(job);
        continue;
      }
      if (!job.needBy) {
        nodate.push({ ...job, band: "nodate" });
        continue;
      }
      const hasTime = load.seconds > 0;
      if (!hasTime) {
        const marked = decorate(job, settings, now);
        blind.push(attachParts({ ...marked, band: "blind" }, settings, now));
        continue;
      }
      const full = decorate(job, settings, now);
      if (settings.holdPre && full.preproduction) {
        held.push(full);
        continue;
      }
      active.push(full);
    }

    blind.sort((a, b) => (a.needBy || 0) - (b.needBy || 0));
    held.sort((a, b) => (a.needBy || 0) - (b.needBy || 0));
    nodate.sort((a, b) => String(a.name).localeCompare(String(b.name)));
    outsourced.sort((a, b) => (a.needBy || 0) - (b.needBy || 0) || String(a.name).localeCompare(String(b.name)));
    barred.sort((a, b) => (a.needBy || 0) - (b.needBy || 0) || String(a.name).localeCompare(String(b.name)));

    let printed;
    let parked;
    if (settings.strategy === "dates") {
      const saved = saveTheDates(active, settings, now);
      printed = saved.printed;
      parked = saved.parked.map((job) => decorate(job, settings, now));
    } else {
      const ordered = orderForStrategy(active, settings);
      printed = scheduleSequence(ordered.printed, settings, now);
      parked = [];
    }

    printed = printed.map((job, index) => attachParts({
      ...job,
      order: index + 1,
      band: bandForSlack(job.queueSlackDays, settings.tightDays),
    }, settings, now));

    parked = parked.map((job) => {
      const aloneLate = job.aloneSlackDays < -0.02;
      return attachParts({
        ...job,
        order: null,
        band: "parked",
        parkReason: aloneLate
          ? "The whole farm, starting now, still finishes after the prints-needed-by date."
          : "Printing this in date order is long enough to push shorter jobs past their dates. Park it and the rest can still make it.",
      }, settings, now);
    });
    held = held.map((job) => attachParts({ ...job, band: "held" }, settings, now));

    const considered = printed.concat(parked);
    const horizons = [7, 14, 30].map((days) => {
      const until = now + days * 86400000;
      const due = considered.filter((j) => j.needBy && j.needBy.getTime() <= until);
      const hours = due.reduce((sum, j) => sum + j.machineHours, 0);
      const capacity = days * settings.machines * settings.hoursPerDay;
      return { days, jobs: due.length, hours, capacity, util: capacity > 0 ? hours / capacity : 0 };
    });

    const materials = new Map();
    for (const job of considered.concat(held)) {
      for (const part of job.materials || []) {
        if (!part.family || !(part.hours > 0)) continue;
        materials.set(part.family, (materials.get(part.family) || 0) + part.hours);
      }
    }

    const late = printed.filter((j) => j.band === "late").concat(parked);
    const tight = printed.filter((j) => j.band === "tight");
    const firstPrinted = printed[0] || null;
    const soonestBlind = blind[0] || null;
    let hero = firstPrinted;
    let heroKind = firstPrinted ? "print" : "empty";
    if (soonestBlind && (!firstPrinted || soonestBlind.needBy <= firstPrinted.needBy)) {
      hero = soonestBlind;
      heroKind = "blind";
    }

    return {
      now,
      printed,
      parked,
      blind,
      held,
      nodate,
      outsourced,
      barred,
      done,
      late,
      tight,
      horizons,
      materials: [...materials.entries()].map(([family, hours]) => ({ family, hours })).sort((a, b) => b.hours - a.hours),
      hero,
      heroKind,
      machineHours: considered.reduce((sum, j) => sum + j.machineHours, 0),
      partsLeft: prepared.reduce((sum, j) => sum + (j.partsLeft || 0), 0),
    };
  }

  function formatClock(seconds) {
    const s = Math.max(0, Math.round(seconds));
    const days = Math.floor(s / 86400);
    const hours = Math.floor((s % 86400) / 3600);
    const mins = Math.floor((s % 3600) / 60);
    if (days > 0) return hours ? `${days}d ${hours}h` : `${days}d`;
    if (hours > 0) return mins ? `${hours}h ${mins}m` : `${hours}h`;
    return `${mins}m`;
  }

  function formatSpan(days) {
    if (!(days > 0)) return "under an hour";
    if (days < 1 / 24) return "under an hour";
    if (days < 1) {
      const hours = Math.max(1, Math.round(days * 24));
      return hours === 1 ? "1h" : `${hours}h`;
    }
    if (days < 3) return `${days.toFixed(1)}d`;
    return `${Math.round(days)}d`;
  }

  function formatSlack(days) {
    if (days == null || Number.isNaN(days)) return "no date";
    const abs = Math.abs(days);
    const word = days < -0.02 ? "late" : "spare";
    if (abs < 0.04) return "on the line";
    if (abs < 1) return `${Math.max(1, Math.round(abs * 24))}h ${word}`;
    return `${abs.toFixed(1)}d ${word}`;
  }

  function formatDay(date) {
    if (!date) return "—";
    const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
    return `${date.getDate()} ${months[date.getMonth()]}`;
  }
  /* BOSQ_PURE_END */

  const DEFAULTS = {
    machines: 6,
    hoursPerDay: 20,
    bufferDays: 7,
    scrap: 0.12,
    tightDays: 3,
    weekends: true,
    holdPre: true,
    dimOk: false,
    strategy: "dates",
    filterOnly: false,
    tuned: false,
    collapsed: false,
    docked: false,
    dockGap: 16,
    top: 78,
    left: null,
    panelWidth: 354,
    panelHeight: null,
  };

  function loadSettings() {
    try {
      const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) || "null");
      return { ...DEFAULTS, ...(saved || {}) };
    } catch {
      return { ...DEFAULTS };
    }
  }

  function saveSettings(next) {
    settings = { ...settings, ...next };
    localStorage.setItem(STORAGE_KEY, JSON.stringify(settings));
  }

  let settings = loadSettings();
  const apiParents = new Map();
  const apiParts = new Map();
  const partCache = new Map();
  let ui = null;
  let scanTimer = null;
  let scanning = false;
  let currentPlan = null;
  let lens = "all";
  let lastFingerprint = "";
  let listScrollReset = false;
  let completeCollapsedOnce = false;
  const rowById = new Map();
  const jobsById = new Map();
  const expandedIds = new Set();
  let outsourceMarks = loadOutsource();
  let barredMarks = loadBarred();
  let boardBulk = false;
  let rowBeaconEl = null;
  let rowBeaconTimer = null;

  function loadOutsource() {
    try {
      const saved = JSON.parse(localStorage.getItem(OUTSOURCE_KEY) || "{}");
      return saved && typeof saved === "object" ? saved : {};
    } catch {
      return {};
    }
  }

  function saveOutsource() {
    localStorage.setItem(OUTSOURCE_KEY, JSON.stringify(outsourceMarks));
  }

  function outsourceRec(jobId) {
    if (!outsourceMarks[jobId]) outsourceMarks[jobId] = { job: false, parts: {} };
    return outsourceMarks[jobId];
  }

  function pruneOutsource(jobId) {
    const rec = outsourceMarks[jobId];
    if (!rec) return;
    const parts = rec.parts || {};
    const anyPart = Object.keys(parts).some((key) => parts[key]);
    if (!rec.job && !anyPart) delete outsourceMarks[jobId];
  }

  function outsourceJobKey(job) {
    return job.workticket || job.id || "";
  }

  function applyOutsourceFlags(job) {
    const rec = outsourceMarks[outsourceJobKey(job)] || outsourceMarks[job.id] || {};
    job.outsourcedJob = !!rec.job;
    (job.parts || []).forEach((part) => {
      part.outsourced = !!(rec.job || (rec.parts && rec.parts[partKey(part.name)]));
    });
    return job;
  }

  function loadBarred() {
    try {
      const saved = JSON.parse(localStorage.getItem(BARRED_KEY) || "{}");
      return saved && typeof saved === "object" ? saved : {};
    } catch {
      return {};
    }
  }

  function saveBarred() {
    localStorage.setItem(BARRED_KEY, JSON.stringify(barredMarks));
  }

  function barredRec(jobId) {
    if (!barredMarks[jobId]) barredMarks[jobId] = { job: false, parts: {} };
    return barredMarks[jobId];
  }

  function pruneBarred(jobId) {
    const rec = barredMarks[jobId];
    if (!rec) return;
    const parts = rec.parts || {};
    const anyPart = Object.keys(parts).some((key) => parts[key]);
    if (!rec.job && !anyPart) delete barredMarks[jobId];
  }

  function applyBarFlags(job) {
    const key = outsourceJobKey(job);
    const rec = barredMarks[key] || barredMarks[job.id] || {};
    job.barredJob = !!rec.job;
    (job.parts || []).forEach((part) => {
      part.barred = !!(rec.job || (rec.parts && rec.parts[partKey(part.name)]));
    });
    return job;
  }

  function clearOutsourceForJob(key) {
    delete outsourceMarks[key];
    saveOutsource();
  }

  function clearBarredForJob(key) {
    delete barredMarks[key];
    saveBarred();
  }

  function clearPartOutsource(key, skuKey) {
    const rec = outsourceMarks[key];
    if (!rec || !rec.parts) return;
    delete rec.parts[skuKey];
    pruneOutsource(key);
    saveOutsource();
  }

  function clearPartBarred(key, skuKey) {
    const rec = barredMarks[key];
    if (!rec || !rec.parts) return;
    delete rec.parts[skuKey];
    pruneBarred(key);
    saveBarred();
  }

  function toggleJobOutsource(job) {
    const key = outsourceJobKey(job);
    const rec = outsourceRec(key);
    rec.job = !rec.job;
    if (rec.job) {
      rec.parts = {};
      clearBarredForJob(key);
    }
    pruneOutsource(key);
    saveOutsource();
  }

  function togglePartOutsource(job, partName) {
    const jobKey = outsourceJobKey(job);
    const rec = outsourceRec(jobKey);
    const skuKey = partKey(partName);
    const openNames = (job.parts || []).filter((part) => part.left > 0).map((part) => part.name);
    if (rec.job) {
      rec.job = false;
      rec.parts = {};
      openNames.forEach((name) => {
        if (partKey(name) !== skuKey) rec.parts[partKey(name)] = true;
      });
    } else {
      rec.parts = rec.parts || {};
      if (rec.parts[skuKey]) delete rec.parts[skuKey];
      else {
        rec.parts[skuKey] = true;
        clearPartBarred(jobKey, skuKey);
      }
      const marked = openNames.filter((name) => rec.parts[partKey(name)]);
      if (openNames.length && marked.length === openNames.length) {
        rec.job = true;
        rec.parts = {};
      }
    }
    pruneOutsource(jobKey);
    saveOutsource();
  }

  function toggleJobBarred(job) {
    const key = outsourceJobKey(job);
    const rec = barredRec(key);
    rec.job = !rec.job;
    if (rec.job) {
      rec.parts = {};
      clearOutsourceForJob(key);
    }
    pruneBarred(key);
    saveBarred();
  }

  function togglePartBarred(job, partName) {
    const jobKey = outsourceJobKey(job);
    const rec = barredRec(jobKey);
    const skuKey = partKey(partName);
    const openNames = (job.parts || []).filter((part) => part.left > 0).map((part) => part.name);
    if (rec.job) {
      rec.job = false;
      rec.parts = {};
      openNames.forEach((name) => {
        if (partKey(name) !== skuKey) rec.parts[partKey(name)] = true;
      });
    } else {
      rec.parts = rec.parts || {};
      if (rec.parts[skuKey]) delete rec.parts[skuKey];
      else {
        rec.parts[skuKey] = true;
        clearPartOutsource(jobKey, skuKey);
      }
      const marked = openNames.filter((name) => rec.parts[partKey(name)]);
      if (openNames.length && marked.length === openNames.length) {
        rec.job = true;
        rec.parts = {};
        clearOutsourceForJob(jobKey);
      }
    }
    pruneBarred(jobKey);
    saveBarred();
  }

  function onBoard() {
    return location.pathname.indexOf("work-centre-planning-board") !== -1;
  }

  function hookNetwork() {
    const origFetch = window.fetch;
    if (typeof origFetch === "function") {
      window.fetch = function () {
        const response = origFetch.apply(this, arguments);
        try {
          const input = arguments[0];
          const url = typeof input === "string" ? input : (input && input.url) || "";
          if (String(url).indexOf("/boards/") !== -1) {
            response.then((res) => {
              res.clone().json().then((data) => ingest(data)).catch(() => {});
            }).catch(() => {});
          }
        } catch (err) { /* ignore */ }
        return response;
      };
    }
    const origOpen = XMLHttpRequest.prototype.open;
    const origSend = XMLHttpRequest.prototype.send;
    XMLHttpRequest.prototype.open = function (method, url) {
      this.__bosqUrl = url;
      return origOpen.apply(this, arguments);
    };
    XMLHttpRequest.prototype.send = function () {
      this.addEventListener("load", function () {
        try {
          if (String(this.__bosqUrl || "").indexOf("/boards/") === -1) return;
          ingest(JSON.parse(this.responseText));
        } catch (err) { /* ignore */ }
      });
      return origSend.apply(this, arguments);
    };
  }

  function ingest(data) {
    const seen = new WeakSet();
    const parents = [];
    const parts = [];
    (function walk(node, depth) {
      if (!node || typeof node !== "object" || depth > 7 || seen.has(node)) return;
      seen.add(node);
      if (Array.isArray(node)) {
        node.forEach((item) => walk(item, depth + 1));
        return;
      }
      const wt = node.WORKTICKETNO || node.workticket_no;
      if (wt && (node.TIME_REMAINING != null || node.EXFACTORY || node.item_name || node.JOBNAME)) {
        parents.push(node);
      }
      if (node.PARTNAME && (node.RUNTIME != null || node.TOTAL_REQ_QTY != null)) parts.push(node);
      Object.keys(node).forEach((key) => {
        if (node[key] && typeof node[key] === "object") walk(node[key], depth + 1);
      });
    })(data, 0);

    parents.forEach((row) => {
      const key = String(row.WORKTICKETNO || row.workticket_no);
      const list = apiParents.get(key) || [];
      list.push(row);
      apiParents.set(key, list);
    });
    parts.forEach((part) => {
      const key = String(part.WORKTICKETNO || "");
      if (!key) return;
      const list = apiParts.get(key) || [];
      list.push(part);
      apiParts.set(key, list);
    });
    scheduleScan();
  }

  function text(el) {
    return (el && el.textContent ? el.textContent : "").replace(/\s+/g, " ").trim();
  }

  function headerMap(table) {
    const headers = [...table.querySelectorAll(":scope > thead th, :scope > thead td")];
    const map = {};
    headers.forEach((th, index) => {
      map[text(th).toLowerCase()] = index;
    });
    return map;
  }

  function findCol(map, hints) {
    const keys = Object.keys(map);
    for (const hint of hints) {
      const hit = keys.find((key) => key.includes(hint));
      if (hit) return map[hit];
    }
    return -1;
  }

  function cell(cells, index) {
    if (index < 0 || !cells[index]) return null;
    return cells[index];
  }

  function numberFrom(el) {
    const raw = text(el).replace(/,/g, "");
    const m = raw.match(/-?\d+(\.\d+)?/);
    return m ? Number(m[0]) : 0;
  }

  function runtimeSeconds(el) {
    if (!el) return 0;
    const titled = el.querySelector("[title]") || el;
    const title = (titled.getAttribute && titled.getAttribute("title")) || "";
    if (/^\d+(\.\d+)?$/.test(title.trim())) return Number(title.trim());
    return parseDuration(text(el));
  }

  function parsePartTable(row) {
    const next = row.nextElementSibling;
    const table = next && next.querySelector("table");
    if (!table) return [];
    const map = headerMap(table);
    const iPart = findCol(map, ["subitem", "part"]);
    const iDesc = findCol(map, ["description"]);
    const iMat = findCol(map, ["material"]);
    const iDone = findCol(map, ["completed"]);
    const iReq = findCol(map, ["required"]);
    const iRun = findCol(map, ["run time", "runtime"]);
    const iWc = findCol(map, ["workcenter", "work centre", "work center"]);
    if (iRun < 0 || iReq < 0) return [];
    const parts = [];
    table.querySelectorAll(":scope > tbody > tr").forEach((tr) => {
      const cells = [...tr.children].filter((el) => el.tagName === "TD");
      if (!cells.length || cells[0].colSpan > 1) return;
      const required = numberFrom(cell(cells, iReq));
      const completed = numberFrom(cell(cells, iDone));
      const left = Math.max(0, required - completed);
      const runtime = runtimeSeconds(cell(cells, iRun));
      const material = text(cell(cells, iMat));
      parts.push({
        name: text(cell(cells, iPart)),
        description: text(cell(cells, iDesc)),
        material,
        family: materialFamily(material),
        workcenter: text(cell(cells, iWc)),
        required,
        completed,
        left,
        runtimeSec: runtime,
        row: tr,
      });
    });
    return parts.filter((part) => part.name || part.required || part.left);
  }

  function visible(el) {
    if (!el) return false;
    const style = window.getComputedStyle(el);
    if (style.display === "none" || style.visibility === "hidden") return false;
    return el.getClientRects().length > 0;
  }

  function activeTabName() {
    const tab = document.querySelector("button.border-b-2.border-blue-500, button.border-b-2.dark\\:border-blue-400");
    return tab ? text(tab) : "This tab";
  }

  function enrichFromApi(job) {
    const rows = apiParents.get(job.workticket) || [];
    if (rows.length !== 1) return job;
    const row = rows[0];
    const remaining = Number(row.TIME_REMAINING);
    if (!(job.boardSeconds > 0) && remaining > 0) job.boardSeconds = remaining;
    const parts = apiParts.get(job.workticket) || [];
    if ((!job.parts || !job.parts.length) && parts.length) {
      job.parts = parts.map((part) => {
        const required = Number(part.TOTAL_REQ_QTY) || 0;
        const completed = Number(part.COMPLETED_QTY) || 0;
        const material = part.Material || part.MATERIAL || part.material || "";
        return {
          name: part.PARTNAME || part.item_name || "",
          description: part.PART_DESCRIPTION || "",
          material,
          family: materialFamily(material),
          workcenter: part.WORKCENTERNAME || "",
          required,
          completed,
          left: Math.max(0, required - completed),
          runtimeSec: Number(part.RUNTIME) || 0,
        };
      });
    }
    return job;
  }

  function readJobs() {
    const rows = [...document.querySelectorAll("tr[data-workticket-no]")].filter(visible);
    const tables = new Map();
    return rows.map((row, index) => {
      const table = row.closest("table");
      if (table && !tables.has(table)) tables.set(table, headerMap(table));
      const map = tables.get(table) || {};
      const cells = [...row.children].filter((el) => el.tagName === "TD");
      const nameCell = cell(cells, findCol(map, ["item name"])) || cells[0];
      const nameNode = nameCell && nameCell.querySelector(".font-medium.text-sm");
      const name = text(nameNode) || text(nameCell);
      let progressEl = cell(cells, findCol(map, ["progress", "time left"]));
      if (!progressEl) progressEl = cells.find((item) => /parts left/i.test(item.textContent)) || null;
      const progress = parseProgress(progressEl ? progressEl.textContent : "");
      const exText = text(cell(cells, findCol(map, ["ex factory"])));
      const stage = text(cell(cells, findCol(map, ["production stage", "stage"])));
      const status = text(cell(cells, findCol(map, ["factory status"])));
      const workticket = row.getAttribute("data-workticket-no") || "";
      const batch = text(cell(cells, findCol(map, ["batch"])));
      const id = ["j", hash([workticket, name, exText, batch, index].join("|"))].join("");
      const parsed = parsePartTable(row);
      if (parsed.length) partCache.set(id, parsed.map((part) => ({ ...part, row: part.row })));
      const cached = partCache.get(id) || [];
      const parts = parsed.length ? parsed : cached.map((part) => ({ ...part, row: undefined }));
      const job = enrichFromApi({
        workticket,
        name: name || workticket,
        exFactory: parseBoardDate(exText),
        exText,
        partsLeft: progress.partsLeft == null
          ? (parts.length ? parts.filter((part) => part.left > 0).reduce((sum, part) => sum + part.left, 0) : null)
          : progress.partsLeft,
        boardSeconds: progress.boardSeconds || 0,
        stage,
        factoryStatus: status,
        engineer: text(cell(cells, findCol(map, ["engineer"]))),
        batch,
        unitQty: text(cell(cells, findCol(map, ["qty"]))),
        fgs: /fgs/i.test(text(cell(cells, findCol(map, ["fgs"])))),
        preproduction: /pre[\s-]*production/i.test(stage),
        parts,
        partMachineSeconds: 0,
        longestPartHours: 0,
        unratedParts: 0,
        materials: [],
        workcenters: [...new Set(parts.map((part) => part.workcenter).filter(Boolean))],
      });
      job.id = id;
      applyOutsourceFlags(job);
      applyBarFlags(job);
      const house = inHouseOpen(job);
      job.partMachineSeconds = house.reduce((sum, part) => sum + part.left * (part.runtimeSec || 0), 0);
      job.longestPartHours = house.reduce((max, part) => Math.max(max, (part.runtimeSec || 0) / 3600), 0);
      job.unratedParts = house.filter((part) => !(part.runtimeSec > 0)).length;
      job.row = row;
      job.progressEl = progressEl;
      return job;
    });
  }

  function hash(value) {
    let h = 2166136261;
    const s = String(value);
    for (let i = 0; i < s.length; i++) {
      h ^= s.charCodeAt(i);
      h = Math.imul(h, 16777619);
    }
    return (h >>> 0).toString(36);
  }

  function viewJobs(jobs) {
    return jobs;
  }

  function cardVisible() {
    return true;
  }

  function jobHasOs(job) {
    if (!job) return false;
    if (job.band === "outsourced" || job.outsourcedJob || job.fullyOut) return true;
    if ((job.outQty || 0) > 0) return true;
    if ((job.partQueue || []).some((part) => part.outsourced)) return true;
    return (job.parts || []).some((part) => part.outsourced && part.left > 0);
  }

  function jobsWithOs(plan) {
    const seen = new Set();
    const list = [];
    const add = (job) => {
      if (!job || seen.has(job.id) || !jobHasOs(job)) return;
      seen.add(job.id);
      list.push(job);
    };
    (plan.outsourced || []).forEach(add);
    (plan.printed || []).forEach(add);
    (plan.parked || []).forEach(add);
    (plan.blind || []).forEach(add);
    (plan.held || []).forEach(add);
    (plan.nodate || []).forEach(add);
    (plan.barred || []).forEach(add);
    return list;
  }

  function jobHasBar(job) {
    if (!job) return false;
    if (job.band === "barred" || job.barredJob) return true;
    if ((job.barQty || 0) > 0) return true;
    if ((job.partQueue || []).some((part) => part.barred)) return true;
    return (job.parts || []).some((part) => part.barred && part.left > 0);
  }

  function jobsWithBar(plan) {
    const seen = new Set();
    const list = [];
    const add = (job) => {
      if (!job || seen.has(job.id) || !jobHasBar(job)) return;
      seen.add(job.id);
      list.push(job);
    };
    (plan.barred || []).forEach(add);
    (plan.printed || []).forEach(add);
    (plan.parked || []).forEach(add);
    (plan.blind || []).forEach(add);
    (plan.held || []).forEach(add);
    (plan.nodate || []).forEach(add);
    (plan.outsourced || []).forEach(add);
    return list;
  }

  function lensVisible(job) {
    if (lens === "all") return true;
    if (lens === "late") return job.band === "late" || job.band === "parked";
    if (lens === "tight") return job.band === "tight";
    if (lens === "blind") return job.band === "blind" || job.band === "nodate";
    if (lens === "outsourced") return jobHasOs(job);
    if (lens === "barred") return jobHasBar(job);
    return true;
  }

  function duplicateCount(jobs) {
    const counts = new Map();
    jobs.forEach((job) => counts.set(job.workticket, (counts.get(job.workticket) || 0) + 1));
    return counts;
  }

  function scheduleScan() {
    if (!onBoard() || boardBulk) return;
    clearTimeout(scanTimer);
    scanTimer = setTimeout(scan, 160);
  }

  function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  function boardTable() {
    const row = document.querySelector("tr[data-workticket-no]");
    return row ? row.closest("table") : null;
  }

  function planningGroupButtons(table) {
    if (!table) return [];
    return [...table.querySelectorAll("button.flex.items-center.gap-2.w-full.text-left.group")].filter((btn) => {
      return btn.querySelector(".tracking-wide") && !btn.closest("#bosq");
    });
  }

  function groupChevronPath(btn) {
    const path = btn.querySelector("svg path");
    return (path && path.getAttribute("d")) || "";
  }

  function isPlanningGroupCollapsed(btn) {
    const d = groupChevronPath(btn);
    return d === "m9 18 6-6-6-6" || d.includes("18 6-6-6-6");
  }

  function isPlanningGroupExpanded(btn) {
    const d = groupChevronPath(btn);
    return d === "m6 9 6 6 6-6" || (d.includes("m6 9") && d.includes("6-6"));
  }

  function workticketToggleButtons(table, label) {
    if (!table) return [];
    return [...table.querySelectorAll(`tr[data-workticket-no] button[aria-label="${label}"]`)];
  }

  function resolveJobRow(job) {
    if (!job) return null;
    if (job.row && job.row.isConnected) return job.row;
    const wt = job.workticket || "";
    const candidates = [...document.querySelectorAll("tr[data-workticket-no]")].filter((row) => {
      return visible(row) && row.getAttribute("data-workticket-no") === wt;
    });
    if (!candidates.length) {
      return [...document.querySelectorAll("tr[data-workticket-no]")].find((row) => row.getAttribute("data-workticket-no") === wt) || null;
    }
    if (candidates.length === 1) return candidates[0];
    const want = (job.name || "").trim().toLowerCase();
    if (want) {
      const hit = candidates.find((row) => {
        const nameEl = row.querySelector(".font-medium.text-sm");
        const name = text(nameEl).toLowerCase();
        return name && (name.includes(want) || want.includes(name));
      });
      if (hit) return hit;
    }
    return candidates[0];
  }

  function planningGroupButtonForRow(row) {
    let el = row;
    while (el) {
      el = el.previousElementSibling;
      if (!el || el.tagName !== "TR") continue;
      const btn = el.querySelector("button.flex.items-center.gap-2.w-full.text-left.group");
      if (btn && btn.querySelector(".tracking-wide")) return btn;
    }
    return null;
  }

  function clearRowBeacon() {
    if (rowBeaconTimer) {
      clearInterval(rowBeaconTimer);
      rowBeaconTimer = null;
    }
    if (rowBeaconEl) {
      rowBeaconEl.remove();
      rowBeaconEl = null;
    }
  }

  function pulseRowHighlight(row) {
    if (!row || !row.isConnected) return;
    clearRowBeacon();
    const beacon = document.createElement("div");
    beacon.className = "bosq-row-beacon";
    beacon.setAttribute("aria-hidden", "true");
    document.body.appendChild(beacon);
    rowBeaconEl = beacon;
    const place = () => {
      if (!row.isConnected) {
        clearRowBeacon();
        return;
      }
      const rect = row.getBoundingClientRect();
      if (!(rect.width > 0 && rect.height > 0)) return;
      beacon.style.top = `${Math.max(0, rect.top)}px`;
      beacon.style.left = `${Math.max(0, rect.left)}px`;
      beacon.style.width = `${rect.width}px`;
      beacon.style.height = `${rect.height}px`;
    };
    place();
    rowBeaconTimer = setInterval(place, 48);
    row.classList.add("bosq-flash");
    const finish = () => {
      row.classList.remove("bosq-flash");
      clearRowBeacon();
    };
    setTimeout(finish, 1300);
  }

  function scrollParentOf(el) {
    let node = el && el.parentElement;
    while (node && node !== document.body) {
      const style = window.getComputedStyle(node);
      const oy = style.overflowY;
      if ((oy === "auto" || oy === "scroll" || oy === "overlay") && node.scrollHeight > node.clientHeight + 8) {
        return node;
      }
      node = node.parentElement;
    }
    return document.scrollingElement || document.documentElement;
  }

  async function scrollRowIntoView(row) {
    if (!row) return;
    const parent = scrollParentOf(row);
    const rowRect = row.getBoundingClientRect();
    const parentRect = parent === document.scrollingElement || parent === document.documentElement
      ? { top: 0, height: window.innerHeight }
      : parent.getBoundingClientRect();
    const offset = Math.round(parentRect.height * 0.28);
    const next = parent.scrollTop + (rowRect.top - parentRect.top) - offset;
    parent.scrollTo({ top: Math.max(0, next), behavior: "smooth" });
    await sleep(420);
  }

  function collapseCompleteOnFirstLoad() {
    if (completeCollapsedOnce) return;
    const table = boardTable();
    if (!table) return;
    const btn = planningGroupButtons(table).find((button) => {
      const label = button.querySelector(".tracking-wide");
      return label && /^complete$/i.test(text(label));
    });
    if (!btn) return;
    completeCollapsedOnce = true;
    if (isPlanningGroupExpanded(btn)) btn.click();
  }

  async function highlightJobRow(job) {
    const row = resolveJobRow(job);
    if (!row) return false;
    await scrollRowIntoView(row);
    pulseRowHighlight(row);
    return true;
  }

  async function highlightPartRow(job, partName) {
    const row = partRowForJob(job, partName);
    if (!row) return false;
    await scrollRowIntoView(row);
    pulseRowHighlight(row);
    return true;
  }

  async function focusJobOnBoard(job, { expandTicket = false } = {}) {
    let row = resolveJobRow(job);
    if (!row) return false;
    const groupBtn = planningGroupButtonForRow(row);
    if (groupBtn && isPlanningGroupCollapsed(groupBtn)) {
      groupBtn.click();
      await sleep(140);
      row = resolveJobRow(job) || row;
    }
    if (expandTicket) {
      const expandBtn = row.querySelector('button[aria-label="Expand"]');
      if (expandBtn) {
        expandBtn.click();
        await sleep(160);
        row = resolveJobRow(job) || row;
      }
    }
    return true;
  }

  async function focusJobFromQueue(job, options) {
    if (!job || boardBulk) return;
    boardBulk = true;
    if (ui && ui.observer) ui.observer.disconnect();
    try {
      await focusJobOnBoard(job, options);
    } finally {
      boardBulk = false;
      lastFingerprint = "";
      await sleep(120);
      scan();
      await sleep(180);
      await highlightJobRow(job);
    }
  }

  function partRowForJob(job, partName) {
    const key = partKey(partName);
    const fromJob = (job.parts || []).find((part) => partKey(part.name) === key);
    if (fromJob && fromJob.row && fromJob.row.isConnected) return fromJob.row;
    const parent = resolveJobRow(job);
    if (!parent) return null;
    const parsed = parsePartTable(parent);
    const hit = parsed.find((part) => partKey(part.name) === key);
    return hit && hit.row ? hit.row : null;
  }

  async function focusPartFromQueue(job, partName) {
    if (!job || !partName || boardBulk) return;
    boardBulk = true;
    if (ui && ui.observer) ui.observer.disconnect();
    try {
      await focusJobOnBoard(job, { expandTicket: true });
    } finally {
      boardBulk = false;
      lastFingerprint = "";
      await sleep(120);
      scan();
      await sleep(180);
      await highlightPartRow(job, partName);
    }
  }

  async function runBoardBulk(task) {
    if (boardBulk) return;
    boardBulk = true;
    if (ui && ui.observer) ui.observer.disconnect();
    try {
      await task();
    } finally {
      boardBulk = false;
      lastFingerprint = "";
      await sleep(120);
      scan();
    }
  }

  async function expandBoardAll() {
    await runBoardBulk(async () => {
      const table = boardTable();
      if (!table) return;
      planningGroupButtons(table).forEach((btn) => {
        if (isPlanningGroupCollapsed(btn)) btn.click();
      });
      await sleep(180);
      for (let pass = 0; pass < 8; pass++) {
        const buttons = workticketToggleButtons(table, "Expand");
        if (!buttons.length) break;
        buttons.forEach((btn) => btn.click());
        await sleep(90);
      }
    });
  }

  async function collapseBoardAll() {
    await runBoardBulk(async () => {
      const table = boardTable();
      if (!table) return;
      workticketToggleButtons(table, "Collapse").forEach((btn) => btn.click());
      await sleep(120);
      planningGroupButtons(table).forEach((btn) => {
        if (isPlanningGroupExpanded(btn)) btn.click();
      });
    });
  }

  function ensureBoardButtons() {
    if (!ui || !ui.root || ui.root.querySelector("[data-act=board-expand]")) return;
    const wrap = document.createElement("div");
    wrap.className = "bosq-board-acts";
    wrap.innerHTML = [
      '<button type="button" data-act="board-expand">Expand all rows</button>',
      '<button type="button" data-act="board-collapse">Collapse all rows</button>',
    ].join("");
    const tools = ui.root.querySelector(".bosq-tools");
    if (tools) tools.after(wrap);
    wrap.querySelector("[data-act=board-expand]").addEventListener("click", () => { expandBoardAll(); });
    wrap.querySelector("[data-act=board-collapse]").addEventListener("click", () => { collapseBoardAll(); });
  }

  function scan() {
    if (!onBoard() || scanning || boardBulk) return;
    scanning = true;
    if (ui && ui.observer) ui.observer.disconnect();
    try {
      ensureUi();
      ensureBoardButtons();
      collapseCompleteOnFirstLoad();
      const jobs = readJobs();
      const plan = buildPlan(viewJobs(jobs), settings, Date.now());
      plan.tab = activeTabName();
      plan.duplicates = duplicateCount(jobs);
      plan.engineers = [...new Set(jobs.map((job) => job.engineer).filter(Boolean))].sort();
      plan.allCount = jobs.length;
      currentPlan = plan;
      jobsById.clear();
      jobs.forEach((job) => jobsById.set(job.id, job));
      applyInline(jobs, plan);
      render(plan, jobs);
    } catch (err) {
      console.warn("[BOS Print Queue]", err);
    } finally {
      scanning = false;
      if (ui && ui.observer && onBoard()) ui.observer.observe(document.body, { childList: true, subtree: true });
    }
  }

  function applyInline(jobs, plan) {
    const byId = new Map();
    plan.printed.concat(plan.parked, plan.blind, plan.held, plan.nodate, plan.outsourced || [], plan.barred || [], plan.done).forEach((job) => byId.set(job.id, job));
    rowById.clear();
    document.querySelectorAll("tr[data-bosq-id]").forEach((row) => {
      if (!jobs.some((job) => job.row === row)) clearInline(row);
    });
    jobs.forEach((job) => {
      const planned = byId.get(job.id);
      rowById.set(job.id, job.row);
      paintRow(job, planned);
    });
  }

  function clearInline(row) {
    row.removeAttribute("data-bosq-band");
    row.removeAttribute("data-bosq-id");
    row.classList.remove("bosq-dim");
    const note = row.querySelector(":scope .bosq-farm");
    if (note) note.remove();
    const next = row.nextElementSibling;
    if (next) {
      next.querySelectorAll("tr[data-bosq-part-band], tr[data-bosq-part]").forEach((tr) => {
        tr.removeAttribute("data-bosq-part-band");
        tr.removeAttribute("data-bosq-part");
      });
    }
  }

  function paintRow(job, planned) {
    const row = job.row;
    const band = planned ? planned.band : "";
    if (band && band !== "done") row.setAttribute("data-bosq-band", band);
    else row.removeAttribute("data-bosq-band");
    row.setAttribute("data-bosq-id", job.id);
    row.classList.toggle("bosq-dim", !!(settings.dimOk && planned && planned.band === "ok"));
    const host = job.progressEl && job.progressEl.querySelector(":scope .flex.flex-col, :scope > div");
    const parent = host || job.progressEl;
    if (!parent || !planned || planned.band === "done") {
      const old = row.querySelector(":scope .bosq-farm");
      if (old) old.remove();
      return;
    }
    let note = parent.querySelector(":scope > .bosq-farm");
    if (!note) {
      note = document.createElement("div");
      note.className = "bosq-farm";
      parent.appendChild(note);
    }
    const line = inlineLine(planned);
    note.textContent = line.label;
    note.title = line.detail;
    note.setAttribute("data-band", planned.band);
    paintPartRows(job, planned);
  }

  function paintPartRows(job, planned) {
    const queue = (planned && planned.partQueue) || [];
    const byName = new Map(queue.map((part) => [partKey(part.name), part]));
    (job.parts || []).forEach((part) => {
      if (!part.row) return;
      if (!(part.left > 0) && !part.outsourced && !part.barred) {
        part.row.removeAttribute("data-bosq-part");
        part.row.removeAttribute("data-bosq-part-band");
        return;
      }
      const ranked = byName.get(partKey(part.name));
      const band = ranked ? ranked.band : (part.barred ? "barred" : (part.outsourced ? "outsourced" : ""));
      part.row.setAttribute("data-bosq-part", part.name);
      if (band) part.row.setAttribute("data-bosq-part-band", band);
      else part.row.removeAttribute("data-bosq-part-band");
    });
  }

  function inlineLine(job) {
    if (job.band === "blind" || job.band === "nodate") {
      return {
        label: job.band === "nodate" ? "! · no ex-factory date" : `! · no runtime · ${job.partsLeft} pts`,
        detail: "Parts are still open, but the board has no print time. The queue cannot see this job.",
      };
    }
    if (job.band === "held") {
      return {
        label: "hold · pre-production",
        detail: "Still in pre-production, so it is not taking a printer ahead of released work.",
      };
    }
    if (job.band === "parked") {
      return {
        label: `park · ${formatSpan(job.capacityDays)} of the farm`,
        detail: job.parkReason,
      };
    }
    if (job.band === "outsourced") {
      return {
        label: job.outQty ? `outsourced · ${job.outQty} pts` : "outsourced",
        detail: "Marked outsourced in the print queue. It is off the farm clock until you unmark it.",
      };
    }
    if (job.band === "barred") {
      return {
        label: job.barQty ? `barred · ${job.barQty} pts` : "barred",
        detail: "Marked barred here — cancelled, moulded elsewhere, or not needed. Off the farm clock until you unbar it.",
      };
    }
    const rank = job.order ? `#${job.order}` : "·";
    return {
      label: `${rank} · ${formatSpan(job.capacityDays)} on farm · ${formatSlack(job.queueSlackDays)}`,
      detail: `${job.workticket}. Board time is one printer (${formatClock(job.usedSeconds)}). On ${settings.machines} printers at ${settings.hoursPerDay}h a day this is about ${formatSpan(job.capacityDays)}, including a ${Math.round(settings.scrap * 100)}% reprint allowance. Prints needed by ${formatDay(job.needBy)}. ${formatSlack(job.queueSlackDays)} once the jobs ahead of it are done.`,
    };
  }

  function ensureUi() {
    if (ui) return;
    const style = document.createElement("style");
    style.textContent = CSS;
    document.documentElement.appendChild(style);
    const root = document.createElement("aside");
    root.id = "bosq";
    root.setAttribute("role", "complementary");
    root.setAttribute("aria-label", "Print queue");
    root.innerHTML = [
      '<header class="bosq-head">',
      '  <button type="button" class="bosq-drag" aria-label="Drag print queue" title="Drag">',
      '    <span class="bosq-markicon" aria-hidden="true"></span>',
      '    <span class="bosq-title">Print queue</span>',
      "  </button>",
      '  <button type="button" class="bosq-icon" data-act="dock" aria-label="Dock to the right" title="Dock to the right">⇥</button>',
      '  <button type="button" class="bosq-icon" data-act="collapse" aria-label="Collapse" title="Collapse (Alt+Q)">–</button>',
      "</header>",
      '<div class="bosq-body">',
      '  <p class="bosq-tune" data-slot="tune" hidden></p>',
      '  <div class="bosq-hero" data-slot="hero"></div>',
      '  <div class="bosq-stats" data-slot="stats"></div>',
      '  <div class="bosq-legend" aria-label="Colour key">',
      '    <span data-band="late"><i></i>Miss</span>',
      '    <span data-band="tight"><i></i>Tight</span>',
      '    <span data-band="blind"><i></i>Blind</span>',
      '    <span data-band="outsourced"><i></i>OS</span>',
      '    <span data-band="barred"><i></i>Bar</span>',
      "  </div>",
      '  <p class="bosq-sensitivity" data-slot="sense"></p>',
      '  <div class="bosq-tools">',
      '    <select data-slot="strategy" aria-label="Queue strategy"></select>',
      "  </div>",
      '  <div class="bosq-board-acts">',
      '    <button type="button" data-act="board-expand">Expand all rows</button>',
      '    <button type="button" data-act="board-collapse">Collapse all rows</button>',
      "  </div>",
      '  <div class="bosq-list" data-slot="list"></div>',
      '  <details class="bosq-settings">',
      "    <summary>Farm settings</summary>",
      '    <div class="bosq-grid">',
      field("Printers", "machines", "1", "80", "1"),
      field("Hours each runs", "hoursPerDay", "1", "24", "1"),
      field("Days before ex factory", "bufferDays", "0", "30", "1"),
      field("Reprint allowance %", "scrapPct", "0", "40", "1"),
      field("Tight if spare under (days)", "tightDays", "0", "14", "1"),
      field("Gap from board (px)", "dockGap", "0", "80", "1"),
      "    </div>",
      check("weekends", "Printers run Saturday and Sunday"),
      check("holdPre", "Hold pre-production off the printers"),
      check("dimOk", "Fade rows that have spare time"),
      '    <div class="bosq-actions">',
      '      <button type="button" data-act="copy">Copy handover</button>',
      '      <button type="button" data-act="reset">Reset settings</button>',
      "    </div>",
      '    <p class="bosq-fine">Time Left on the board is one printer running nonstop. Ex factory is when the unit leaves, so prints are pulled forward by the buffer above. Outsourced marks live only in this browser — they never write back to BOS. Expand a job card to see which SKUs to print first.</p>',
      "  </details>",
      "</div>",
      '<div class="bosq-resize bosq-resize-w" title="Drag to resize width" aria-hidden="true"></div>',
      '<div class="bosq-resize bosq-resize-e" title="Drag to resize width" aria-hidden="true"></div>',
      '<div class="bosq-resize bosq-resize-s" title="Drag to resize height" aria-hidden="true"></div>',
      '<div class="bosq-resize bosq-resize-se" title="Drag to resize" aria-hidden="true"></div>',
    ].join("");
    document.documentElement.appendChild(root);
    const strategy = root.querySelector("[data-slot=strategy]");
    [
      ["dates", "Save the dates"],
      ["edd", "Earliest ex factory"],
      ["slack", "Tightest slack"],
      ["short", "Short jobs first"],
    ].forEach(([value, label]) => {
      const option = document.createElement("option");
      option.value = value;
      option.textContent = label;
      strategy.appendChild(option);
    });
    strategy.value = settings.strategy;
    strategy.addEventListener("change", () => {
      saveSettings({ strategy: strategy.value });
      lastFingerprint = "";
      scan();
    });
    root.querySelectorAll("[data-setting]").forEach((input) => {
      input.addEventListener("change", () => applySettingInput(input));
    });
    root.querySelector("[data-act=dock]").addEventListener("click", toggleDocked);
    root.querySelector("[data-act=collapse]").addEventListener("click", toggleCollapsed);
    root.querySelector("[data-act=board-expand]").addEventListener("click", () => { expandBoardAll(); });
    root.querySelector("[data-act=board-collapse]").addEventListener("click", () => { collapseBoardAll(); });
    root.querySelector("[data-act=copy]").addEventListener("click", copyHandover);
    root.querySelector("[data-act=reset]").addEventListener("click", () => {
      localStorage.removeItem(STORAGE_KEY);
      settings = { ...DEFAULTS };
      lastFingerprint = "";
      applyDocked();
      fillSettings();
      scan();
    });
    root.addEventListener("click", onPanelClick);
    dragPanel(root.querySelector(".bosq-head"), root);
    root.querySelectorAll(".bosq-resize").forEach((handle) => {
      const mode = handle.classList.contains("bosq-resize-se")
        ? "se"
        : handle.classList.contains("bosq-resize-w")
          ? "w"
          : handle.classList.contains("bosq-resize-e")
            ? "e"
            : "s";
      resizePanel(handle, root, mode);
    });
    const observer = new MutationObserver((mutations) => {
      const internal = mutations.every((mutation) => {
        const node = mutation.target.nodeType === 1 ? mutation.target : mutation.target.parentElement;
        return node && node.closest && node.closest("#bosq");
      });
      if (!internal) scheduleScan();
    });
    ui = { root, observer };
    applyDocked();
    fillSettings();
    place();
    window.addEventListener("resize", place);
  }

  function field(label, key, min, max, step) {
    return `<label>${label}<input data-setting="${key}" type="number" min="${min}" max="${max}" step="${step}"></label>`;
  }

  function check(key, label) {
    return `<label class="bosq-check"><input data-setting="${key}" type="checkbox"><span>${label}</span></label>`;
  }

  function fillSettings() {
    if (!ui) return;
    const root = ui.root;
    root.querySelector('[data-setting="machines"]').value = settings.machines;
    root.querySelector('[data-setting="hoursPerDay"]').value = settings.hoursPerDay;
    root.querySelector('[data-setting="bufferDays"]').value = settings.bufferDays;
    root.querySelector('[data-setting="scrapPct"]').value = Math.round(settings.scrap * 100);
    root.querySelector('[data-setting="tightDays"]').value = settings.tightDays;
    const gap = root.querySelector('[data-setting="dockGap"]');
    if (gap) gap.value = settings.dockGap;
    root.querySelector('[data-setting="weekends"]').checked = !!settings.weekends;
    root.querySelector('[data-setting="holdPre"]').checked = !!settings.holdPre;
    root.querySelector('[data-setting="dimOk"]').checked = !!settings.dimOk;
    root.querySelector("[data-slot=strategy]").value = settings.strategy;
  }

  function applySettingInput(input) {
    const key = input.getAttribute("data-setting");
    if (input.type === "checkbox") {
      saveSettings({ [key]: input.checked });
    } else if (key === "scrapPct") {
      saveSettings({ scrap: clamp(Number(input.value) / 100, 0, 0.4) });
    } else {
      const limits = { machines: [1, 80], hoursPerDay: [1, 24], bufferDays: [0, 30], tightDays: [0, 14], dockGap: [0, 80] };
      const [min, max] = limits[key] || [0, 999];
      const patch = { [key]: clamp(Number(input.value), min, max) };
      if (key === "machines") patch.tuned = true;
      saveSettings(patch);
      input.value = key === "scrapPct" ? Math.round(settings.scrap * 100) : settings[key];
    }
    lastFingerprint = "";
    if (key === "dockGap") place();
    scan();
  }

  function clamp(value, min, max) {
    if (!Number.isFinite(value)) return min;
    return Math.min(max, Math.max(min, value));
  }

  const PANEL_MIN_W = 268;
  const PANEL_MAX_W = 720;
  const PANEL_MIN_H = 248;
  const PANEL_COLLAPSED_W = 160;

  function panelMaxWidth() {
    if (settings.docked) return Math.max(PANEL_MIN_W, window.innerWidth - 280);
    return PANEL_MAX_W;
  }

  function panelWidthNow() {
    if (settings.collapsed) return PANEL_COLLAPSED_W;
    return clamp(settings.panelWidth || 354, PANEL_MIN_W, panelMaxWidth());
  }

  function applyDockPad() {
    const on = !!(settings.docked && onBoard() && ui && ui.root && !ui.root.hidden);
    document.documentElement.classList.toggle("bosq-is-docked", on);
    const pad = on ? panelWidthNow() + clamp(settings.dockGap || 0, 0, 80) : 0;
    document.documentElement.style.setProperty("--bosq-dock-pad", pad + "px");
  }

  function place() {
    const root = ui && ui.root;
    if (!root) return;
    root.classList.toggle("is-docked", !!settings.docked);
    const margin = 12;
    const collapsed = !!settings.collapsed;
    const width = panelWidthNow();
    root.style.width = width + "px";
    if (settings.docked) {
      root.style.top = "0px";
      root.style.left = "auto";
      root.style.right = "0px";
      root.style.height = "100vh";
      root.style.maxHeight = "100vh";
      applyDockPad();
      return;
    }
    const maxTop = Math.max(margin, window.innerHeight - 80);
    let top = settings.top == null ? 72 : settings.top;
    if (top < margin || top > maxTop) top = Math.min(72, maxTop);
    root.style.top = top + "px";
    const maxHeight = Math.max(PANEL_MIN_H, window.innerHeight - top - margin);
    if (collapsed) {
      root.style.height = "";
      root.style.maxHeight = "";
    } else if (settings.panelHeight > 0) {
      const height = clamp(settings.panelHeight, PANEL_MIN_H, maxHeight);
      root.style.height = height + "px";
      root.style.maxHeight = maxHeight + "px";
    } else {
      root.style.height = "";
      root.style.maxHeight = maxHeight + "px";
    }
    if (settings.left == null) {
      root.style.left = "auto";
      root.style.right = "16px";
    } else {
      const maxLeft = Math.max(margin, window.innerWidth - Math.min(width, window.innerWidth - margin));
      const left = Math.min(maxLeft, Math.max(margin, settings.left));
      root.style.left = left + "px";
      root.style.right = "auto";
    }
    applyDockPad();
  }

  function dragPanel(head, root) {
    let dx = 0;
    let dy = 0;
    let moved = false;
    head.addEventListener("pointerdown", (event) => {
      if (event.button !== 0) return;
      if (settings.docked) return;
      if (event.target.closest(".bosq-icon")) return;
      if (event.target.closest("input, select, textarea, summary, a")) return;
      const rect = root.getBoundingClientRect();
      dx = event.clientX - rect.left;
      dy = event.clientY - rect.top;
      moved = false;
      root.classList.add("bosq-moving");
      head.setPointerCapture(event.pointerId);
      event.preventDefault();
    });
    head.addEventListener("pointermove", (event) => {
      if (!head.hasPointerCapture(event.pointerId)) return;
      moved = true;
      const width = root.offsetWidth || PANEL_COLLAPSED_W;
      const left = Math.min(window.innerWidth - width - 8, Math.max(8, event.clientX - dx));
      const top = Math.min(window.innerHeight - 48, Math.max(8, event.clientY - dy));
      settings.left = left;
      settings.top = top;
      place();
    });
    const end = () => {
      root.classList.remove("bosq-moving");
      if (moved) saveSettings({ left: settings.left, top: settings.top });
    };
    head.addEventListener("pointerup", end);
    head.addEventListener("pointercancel", end);
  }

  function resizePanel(handle, root, mode) {
    let startX = 0;
    let startY = 0;
    let startW = 0;
    let startH = 0;
    let moved = false;
    handle.addEventListener("pointerdown", (event) => {
      if (event.button !== 0 || settings.collapsed) return;
      event.preventDefault();
      event.stopPropagation();
      const rect = root.getBoundingClientRect();
      startX = event.clientX;
      startY = event.clientY;
      startW = rect.width;
      startH = rect.height;
      moved = false;
      root.classList.add("bosq-resizing");
      handle.setPointerCapture(event.pointerId);
    });
    handle.addEventListener("pointermove", (event) => {
      if (!handle.hasPointerCapture(event.pointerId)) return;
      moved = true;
      const dx = event.clientX - startX;
      const dy = event.clientY - startY;
      if (mode === "e" || mode === "se") {
        settings.panelWidth = clamp(startW + dx, PANEL_MIN_W, panelMaxWidth());
      }
      if (mode === "w") {
        settings.panelWidth = clamp(startW - dx, PANEL_MIN_W, panelMaxWidth());
      }
      if (mode === "s" || mode === "se") {
        const margin = 12;
        const top = root.getBoundingClientRect().top;
        const maxH = Math.max(PANEL_MIN_H, window.innerHeight - top - margin);
        settings.panelHeight = clamp(startH + dy, PANEL_MIN_H, maxH);
      }
      place();
    });
    const end = () => {
      root.classList.remove("bosq-resizing");
      if (moved) saveSettings({ panelWidth: settings.panelWidth, panelHeight: settings.panelHeight });
    };
    handle.addEventListener("pointerup", end);
    handle.addEventListener("pointercancel", end);
  }

  function toggleCollapsed() {
    saveSettings({ collapsed: !settings.collapsed });
    applyCollapsed();
  }

  function toggleDocked() {
    saveSettings({ docked: !settings.docked, collapsed: settings.docked ? settings.collapsed : false });
    applyDocked();
  }

  function applyDocked() {
    if (!ui) return;
    const button = ui.root.querySelector("[data-act=dock]");
    if (button) {
      button.textContent = settings.docked ? "⇤" : "⇥";
      button.setAttribute("aria-label", settings.docked ? "Undock print queue" : "Dock to the right");
      button.title = settings.docked ? "Undock" : "Dock to the right";
      button.classList.toggle("is-on", !!settings.docked);
    }
    applyCollapsed();
  }

  function applyCollapsed() {
    if (!ui) return;
    ui.root.classList.toggle("is-collapsed", !!settings.collapsed);
    ui.root.classList.toggle("is-docked", !!settings.docked);
    ui.root.querySelectorAll(".bosq-resize").forEach((el) => {
      el.hidden = !!settings.collapsed;
    });
    const button = ui.root.querySelector("[data-act=collapse]");
    button.textContent = settings.collapsed ? "+" : "–";
    button.setAttribute("aria-label", settings.collapsed ? "Expand print queue" : "Collapse print queue");
    place();
  }

  function displayHero(plan) {
    const blind = plan.blind.filter(cardVisible);
    const printed = plan.printed.filter(cardVisible);
    const soonestBlind = blind[0];
    const first = printed[0];
    if (soonestBlind && (!first || soonestBlind.needBy <= first.needBy)) return { hero: soonestBlind, heroKind: "blind" };
    if (first) return { hero: first, heroKind: "print" };
    if (plan.hero && cardVisible(plan.hero)) return { hero: plan.hero, heroKind: plan.heroKind };
    return { hero: null, heroKind: "empty" };
  }

  function render(plan, jobs) {
    const root = ui.root;
    const shown = displayHero(plan);
    const tune = root.querySelector("[data-slot=tune]");
    if (!settings.tuned) {
      tune.hidden = false;
      tune.textContent = "Assuming 6 printers × 20h. Set the real count in Farm settings.";
    } else tune.hidden = true;

    root.querySelector("[data-slot=hero]").innerHTML = heroHtml(shown);
    root.querySelector("[data-slot=stats]").innerHTML = statsHtml(plan);
    root.querySelector("[data-slot=sense]").textContent = sensitivity(plan, jobs);

    const fingerprint = fingerprintOf(plan);
    const list = root.querySelector("[data-slot=list]");
    if (fingerprint !== lastFingerprint) {
      const scroll = listScrollReset ? 0 : list.scrollTop;
      list.innerHTML = listHtml(plan);
      list.scrollTop = scroll;
      lastFingerprint = fingerprint;
    } else if (listScrollReset) {
      list.scrollTop = 0;
    }
    listScrollReset = false;
    root.querySelectorAll(".bosq-stat").forEach((button) => {
      button.classList.toggle("is-on", button.getAttribute("data-lens") === lens);
    });
  }

  function heroHtml(shown) {
    if (!shown.hero) {
      return `<div class="bosq-hero-kicker">Nothing open</div><div class="bosq-hero-name">No open print time.</div>`;
    }
    const job = shown.hero;
    if (shown.heroKind === "blind") {
      return [
        '<div class="bosq-hero-kicker">Check first</div>',
        `<div class="bosq-hero-name">${esc(job.name)}</div>`,
        `<div class="bosq-hero-meta">${esc(formatDay(job.exFactory))} · ${esc(String(job.partsLeft))} left · no runtime</div>`,
      ].join("");
    }
    return [
      `<div class="bosq-hero-kicker">Start · #${job.order}</div>`,
      `<div class="bosq-hero-name">${esc(job.name)}</div>`,
      `<div class="bosq-hero-meta">${esc(formatDay(job.exFactory))} · ${esc(formatSpan(job.capacityDays))} · ${esc(formatSlack(job.queueSlackDays))}</div>`,
    ].join("");
  }

  function statsHtml(plan) {
    const chips = [
      ["late", plan.late.length, "Miss"],
      ["tight", plan.tight.length, "Tight"],
      ["blind", plan.blind.length + plan.nodate.length, "Blind"],
      ["outsourced", jobsWithOs(plan).length, "OS"],
      ["barred", jobsWithBar(plan).length, "Bar"],
    ];
    return chips.map(([key, count, label]) =>
      `<button type="button" class="bosq-stat" data-lens="${key}"><b>${count}</b><span>${label}</span></button>`
    ).join("");
  }

  function sensitivity(plan, jobs) {
    if (!plan.printed.length && !plan.parked.length) return plan.blind.length ? "Blind rows are excluded from the farm clock until they have a runtime." : "";
    const current = plan.late.length;
    const around = [];
    [settings.machines - 2, settings.machines, settings.machines + 2].forEach((count) => {
      if (count < 1 || count === settings.machines) return;
      around.push({ count, late: lateAt(jobs, count) });
    });
    const less = around.find((item) => item.count < settings.machines);
    const more = around.find((item) => item.count > settings.machines);
    const bits = [`${settings.machines} printers: ${current === 0 ? "dates hold" : current + " miss"}`];
    if (less) bits.unshift(`${less.count} printers: ${less.late === 0 ? "clear" : less.late + " miss"}`);
    if (more) bits.push(`${more.count} printers: ${more.late === 0 ? "clear" : more.late + " miss"}`);
    const load = plan.horizons.find((item) => item.days === 14);
    if (load) bits.push(`next 14d is ${Math.round(load.util * 100)}% full`);
    return bits.join(" · ");
  }

  function lateAt(jobs, machines) {
    const trial = buildPlan(viewJobs(jobs), { ...settings, machines }, Date.now());
    return trial.late.length;
  }

  function listHtml(plan) {
    if (lens === "outsourced") {
      const jobs = jobsWithOs(plan);
      if (!jobs.length) return '<div class="bosq-empty">Nothing marked outsourced.</div>';
      return section("Outsourced", jobs, "Local marks · only OS SKUs");
    }
    if (lens === "barred") {
      const jobs = jobsWithBar(plan);
      if (!jobs.length) return '<div class="bosq-empty">Nothing marked barred.</div>';
      return section("Barred", jobs, "Not needed · only barred SKUs");
    }
    const sections = [];
    const blind = plan.blind.concat(plan.nodate).filter(lensVisible);
    const parked = plan.parked.filter(lensVisible);
    const printed = plan.printed.filter(lensVisible);
    const held = plan.held.filter(lensVisible);
    const outsourced = (plan.outsourced || []).filter(lensVisible);
    const barredJobs = (plan.barred || []).filter(lensVisible);
    if (blind.length) sections.push(section("No runtime", blind, "Open parts, 0m left"));
    if (parked.length) sections.push(section("Park", parked, "Would push other dates"));
    if (printed.length) sections.push(section("Print order", printed, strategyBlurb()));
    if (held.length) sections.push(section("Held", held, "Pre-production"));
    if (outsourced.length) sections.push(section("Outsourced", outsourced, "Local marks · off farm"));
    if (barredJobs.length) sections.push(section("Barred", barredJobs, "Not needed · off farm"));
    if (!sections.length) {
      return `<div class="bosq-empty">${plan.allCount ? "Nothing in this view." : "Waiting for the board…"}</div>`;
    }
    return sections.join("");
  }

  function strategyBlurb() {
    if (settings.strategy === "edd") return "Strict date order";
    if (settings.strategy === "slack") return "Least spare first";
    if (settings.strategy === "short") return "Short jobs first";
    return "Dates, parking sink jobs";
  }

  function section(title, jobs, note) {
    return `<section><h3>${esc(title)}</h3><p>${esc(note)}</p>${jobs.map(cardHtml).join("")}</section>`;
  }

  function cardHtml(job) {
    const open = expandedIds.has(job.id);
    const rank = job.order ? `#${job.order}` : labelFor(job.band);
    const qty = lens === "outsourced" || job.band === "outsourced"
      ? (job.outQty ? `${job.outQty} OS` : "OS")
      : lens === "barred" || job.band === "barred"
        ? (job.barQty ? `${job.barQty} bar` : "bar")
        : (job.farmQty != null ? String(job.farmQty) : (job.partsLeft != null ? String(job.partsLeft) : ""));
    const slack = job.band === "blind" ? "no runtime"
      : job.band === "nodate" ? "no date"
      : job.band === "outsourced" ? "off farm"
      : job.band === "barred" ? "barred"
      : job.band === "parked" ? formatSlack(job.aloneSlackDays)
      : formatSlack(job.queueSlackDays);
    const farm = (job.band !== "outsourced" && job.band !== "barred" && job.capacityDays > 0) ? formatSpan(job.capacityDays) : "";
    const meta = [rank, formatDay(job.exFactory), qty, farm, slack].filter(Boolean).join(" · ");
    const cue = job.partCue ? job.partCue.replace(/^Print first:\s*/i, "→ ") : "";
    const osOn = !!job.outsourcedJob || job.band === "outsourced";
    const barOn = !!job.barredJob || job.band === "barred";
    const cardBand = lens === "outsourced" ? "outsourced" : (lens === "barred" ? "barred" : job.band);
    const hideCue = lens === "outsourced" || lens === "barred";
    return `<article class="bosq-card" data-band="${esc(cardBand)}" data-job="${esc(job.id)}">
      <div class="bosq-card-top">
        <button type="button" class="bosq-card-jump" data-open="${esc(job.id)}">
          <span class="bosq-card-name">${esc(job.name)}</span>
          <span class="bosq-card-meta">${esc(meta)}</span>
          ${cue && !hideCue ? `<span class="bosq-card-cue">${esc(cue)}</span>` : ""}
        </button>
        <div class="bosq-card-acts">
          <button type="button" class="bosq-os ${osOn ? "is-on" : ""}" data-os-job="${esc(job.id)}" title="${osOn ? "Unmark outsourced" : "Mark whole job outsourced"}">OS</button>
          <button type="button" class="bosq-bar-btn ${barOn ? "is-on" : ""}" data-bar-job="${esc(job.id)}" title="${barOn ? "Unbar job" : "Bar whole job (ignore on farm)"}">BAR</button>
          <button type="button" class="bosq-more" data-expand="${esc(job.id)}" aria-expanded="${open ? "true" : "false"}" title="${open ? "Hide parts" : "Show which parts to print first"}">${open ? "–" : "+"}</button>
        </div>
      </div>
      ${open ? partsHtml(job) : ""}
    </article>`;
  }

  function partsHtml(job) {
    let queue = job.partQueue || [];
    if (lens === "outsourced") queue = queue.filter((part) => part.outsourced);
    if (lens === "barred") queue = queue.filter((part) => part.barred);
    if (!queue.length) {
      const empty = lens === "outsourced"
        ? "No OS SKUs loaded yet. Expand the row on the board."
        : lens === "barred"
          ? "No barred SKUs loaded yet. Expand the row on the board."
          : "Expand this job on the board to see SKUs.";
      return `<div class="bosq-parts"><p class="bosq-parts-empty">${empty}</p></div>`;
    }
    const rows = queue.map((part) => {
      const osOn = !!part.outsourced;
      const barOn = !!part.barred;
      const tag = part.first ? "first" : part.band;
      const label = part.first
        ? `#${part.order}`
        : part.order
          ? `#${part.order}`
          : labelFor(part.band);
      const clock = part.band === "blind"
        ? `${part.left} · no runtime`
        : part.band === "outsourced"
          ? `${part.left} left`
          : part.band === "barred"
            ? `${part.left} left`
            : `${part.left} × ${formatClock(part.runtimeSec)} · ${formatClock(part.hours * 3600)} · ${formatSlack(part.slack)}`;
      return `<div class="bosq-part" data-band="${esc(part.band)}">
        <button type="button" class="bosq-part-body" data-part-jump="${esc(job.id)}" data-part-name="${esc(part.name)}">
          <span class="bosq-part-tag" data-tag="${esc(tag)}">${esc(label)}</span>
          <span class="bosq-part-name">${esc(part.name)}</span>
          <span class="bosq-part-clock">${esc(clock)}</span>
        </button>
        <div class="bosq-part-acts">
          <button type="button" class="bosq-os ${osOn ? "is-on" : ""}" data-os-part="${esc(part.name)}" data-os-job="${esc(job.id)}" title="${osOn ? "Print in-house" : "Outsource SKU"}">OS</button>
          <button type="button" class="bosq-bar-btn ${barOn ? "is-on" : ""}" data-bar-part="${esc(part.name)}" data-bar-job="${esc(job.id)}" title="${barOn ? "Unbar SKU" : "Bar SKU (ignore)"}">BAR</button>
        </div>
      </div>`;
    }).join("");
    return `<div class="bosq-parts">${rows}</div>`;
  }

  function labelFor(band) {
    if (band === "parked") return "Park";
    if (band === "blind") return "Blind";
    if (band === "held") return "Hold";
    if (band === "nodate") return "No date";
    if (band === "late") return "Miss";
    if (band === "tight") return "Tight";
    if (band === "outsourced") return "OS";
    if (band === "barred") return "Bar";
    return "Ok";
  }

  function materialHtml(plan) {
    if (!plan.materials.length) {
      return '<p class="bosq-fine">Expand a job to split the open parts by material. PETG and PLA want their own runs so you are not purging between every plate.</p>';
    }
    const max = plan.materials[0].hours || 1;
    const rows = plan.materials.map((item) =>
      `<div class="bosq-mat"><span>${esc(item.family)}</span><span class="bosq-bar"><i style="width:${Math.max(6, (item.hours / max) * 100)}%"></i></span><span>${esc(formatClock(item.hours * 3600))}</span></div>`
    ).join("");
    return `<section><h3>Material in expanded jobs</h3><p>Only parts you have expanded. Group a wave of the same family when the dates allow it.</p>${rows}</section>`;
  }

  function fingerprintOf(plan) {
    const pack = (job) => [job.id, job.band, job.order, Math.round((job.queueSlackDays || 0) * 10), job.partCue, job.outQty, expandedIds.has(job.id) ? 1 : 0].join(":");
    return [plan.tab, lens, settings.dimOk, JSON.stringify(outsourceMarks), JSON.stringify(barredMarks), plan.printed.map(pack).join(","), plan.parked.map(pack).join(","), plan.blind.map(pack).join(","), plan.held.map(pack).join(","), (plan.outsourced || []).map(pack).join(","), (plan.barred || []).map(pack).join(","), jobsWithOs(plan).map(pack).join(","), jobsWithBar(plan).map(pack).join(",")].join("~");
  }

  function onPanelClick(event) {
    const lensButton = event.target.closest("[data-lens]");
    if (lensButton) {
      const next = lensButton.getAttribute("data-lens");
      lens = lens === next ? "all" : next;
      lastFingerprint = "";
      listScrollReset = true;
      scan();
      return;
    }
    const osPart = event.target.closest("button[data-os-part]");
    if (osPart) {
      event.preventDefault();
      event.stopPropagation();
      const job = jobsById.get(osPart.getAttribute("data-os-job"));
      if (job) {
        togglePartOutsource(job, osPart.getAttribute("data-os-part"));
        lastFingerprint = "";
        scan();
      }
      return;
    }
    const osJob = event.target.closest("button[data-os-job]:not([data-os-part])");
    if (osJob) {
      event.preventDefault();
      event.stopPropagation();
      const job = jobsById.get(osJob.getAttribute("data-os-job"));
      if (job) {
        toggleJobOutsource(job);
        lastFingerprint = "";
        scan();
      }
      return;
    }
    const barPart = event.target.closest("button[data-bar-part]");
    if (barPart) {
      event.preventDefault();
      event.stopPropagation();
      const job = jobsById.get(barPart.getAttribute("data-bar-job"));
      if (job) {
        togglePartBarred(job, barPart.getAttribute("data-bar-part"));
        lastFingerprint = "";
        scan();
      }
      return;
    }
    const barJob = event.target.closest("button[data-bar-job]:not([data-bar-part])");
    if (barJob) {
      event.preventDefault();
      event.stopPropagation();
      const job = jobsById.get(barJob.getAttribute("data-bar-job"));
      if (job) {
        toggleJobBarred(job);
        lastFingerprint = "";
        scan();
      }
      return;
    }
    const partJump = event.target.closest("[data-part-jump]");
    if (partJump) {
      event.preventDefault();
      event.stopPropagation();
      const job = jobsById.get(partJump.getAttribute("data-part-jump"));
      const partName = partJump.getAttribute("data-part-name");
      if (job && partName) focusPartFromQueue(job, partName);
      return;
    }
    const expand = event.target.closest("[data-expand]");
    if (expand) {
      event.preventDefault();
      event.stopPropagation();
      const id = expand.getAttribute("data-expand");
      const opening = !expandedIds.has(id);
      if (opening) expandedIds.add(id);
      else expandedIds.delete(id);
      lastFingerprint = "";
      if (opening) {
        const job = jobsById.get(id);
        if (job) {
          focusJobFromQueue(job, { expandTicket: true });
          return;
        }
      }
      scan();
      return;
    }
    const card = event.target.closest("[data-open]");
    if (!card) return;
    event.preventDefault();
    const job = jobsById.get(card.getAttribute("data-open"));
    if (!job) return;
    focusJobFromQueue(job, { expandTicket: false });
  }

  function copyHandover() {
    if (!currentPlan) return;
    const plan = currentPlan;
    const lines = [
      `Print queue · ${plan.tab}`,
      `${new Date().toLocaleString()} · ${settings.machines} printers × ${settings.hoursPerDay}h · ${settings.bufferDays}d before ex factory · ${Math.round(settings.scrap * 100)}% reprint allowance`,
      "",
    ];
    if (plan.blind.length) {
      lines.push("No runtime:");
      plan.blind.forEach((job) => lines.push(`- ${job.workticket} · ships ${formatDay(job.exFactory)} · ${job.partsLeft} parts · ${job.name}`));
      lines.push("");
    }
    if (plan.parked.length) {
      lines.push("Park:");
      plan.parked.forEach((job) => lines.push(`- ${job.workticket} · ${formatSpan(job.capacityDays)} of the farm · ${job.name}`));
      lines.push("");
    }
    if ((plan.outsourced || []).length) {
      lines.push("Outsourced:");
      plan.outsourced.forEach((job) => lines.push(`- ${job.workticket} · ${job.outQty || 0} pts · ${job.name}`));
      lines.push("");
    }
    if ((plan.barred || []).length) {
      lines.push("Barred:");
      plan.barred.forEach((job) => lines.push(`- ${job.workticket} · ${job.barQty || 0} pts · ${job.name}`));
      lines.push("");
    }
    lines.push("Print order:");
    plan.printed.forEach((job) => {
      lines.push(`${job.order}. ${job.workticket} · ships ${formatDay(job.exFactory)} · needed ${formatDay(job.needBy)} · ${formatSlack(job.queueSlackDays)} · ${job.name}`);
      (job.partQueue || []).filter((part) => part.order).forEach((part) => {
        lines.push(`   ${part.order}. ${part.name} · ${part.left} left · ${formatClock((part.hours || 0) * 3600)} · ${part.band}${part.first ? " · print first" : ""}`);
      });
    });
    const text = lines.join("\n");
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(() => flashCopy("Copied")).catch(() => fallbackCopy(text));
    } else fallbackCopy(text);
  }

  function fallbackCopy(text) {
    const area = document.createElement("textarea");
    area.value = text;
    document.body.appendChild(area);
    area.select();
    document.execCommand("copy");
    area.remove();
    flashCopy("Copied");
  }

  function flashCopy(message) {
    const button = ui.root.querySelector("[data-act=copy]");
    const old = button.textContent;
    button.textContent = message;
    setTimeout(() => { button.textContent = old; }, 1200);
  }

  function esc(value) {
    return String(value == null ? "" : value).replace(/[&<>"']/g, (ch) => ({
      "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
    }[ch]));
  }

  function boot() {
    if (!document.body) return;
    ensureUi();
    if (onBoard()) {
      ui.root.hidden = false;
      applyDockPad();
      scan();
    } else {
      ui.root.hidden = true;
      applyDockPad();
    }
  }

  function watchNavigation() {
    const wrap = (name) => {
      const orig = history[name];
      history[name] = function () {
        const result = orig.apply(this, arguments);
        setTimeout(boot, 0);
        return result;
      };
    };
    wrap("pushState");
    wrap("replaceState");
    window.addEventListener("popstate", () => setTimeout(boot, 0));
  }

  document.addEventListener("keydown", (event) => {
    if (!onBoard() || event.altKey === false || event.shiftKey || event.ctrlKey || event.metaKey) return;
    if (event.key !== "q" && event.key !== "Q") return;
    const tag = event.target && event.target.tagName;
    if (tag === "INPUT" || tag === "TEXTAREA" || (event.target && event.target.isContentEditable)) return;
    event.preventDefault();
    if (!ui) boot();
    toggleCollapsed();
  }, true);

  hookNetwork();
  watchNavigation();
  setInterval(() => { if (onBoard()) scheduleScan(); }, 4000);

  const CSS = `
    html.bosq-is-docked, html.bosq-is-docked body, html.bosq-is-docked #root, html.bosq-is-docked .App {
      padding-right: var(--bosq-dock-pad, 0px) !important;
      box-sizing: border-box;
    }
    #bosq, #bosq * { box-sizing: border-box; }
    #bosq {
      position: fixed; z-index: 80; top: 72px; right: 16px; width: 354px; max-height: calc(100vh - 84px);
      display: flex; flex-direction: column;
      color: #e8e6e1; background: #161513;
      border: 1px solid rgba(255,255,255,.08);
      border-radius: 16px;
      box-shadow: 0 22px 56px rgba(0,0,0,.38), 0 2px 0 rgba(255,255,255,.04) inset;
      font: 12px/1.35 "Segoe UI", sans-serif;
      letter-spacing: 0;
      touch-action: none;
    }
    #bosq.is-collapsed { max-height: none; }
    #bosq.is-collapsed .bosq-body { display: none; }
    #bosq[hidden] { display: none !important; }
    #bosq.bosq-moving, #bosq.bosq-resizing { user-select: none; }
    #bosq.is-docked {
      top: 0 !important; right: 0 !important; left: auto !important;
      height: 100vh !important; max-height: 100vh !important;
      border-radius: 0; border-right: 0; border-top: 0; border-bottom: 0;
      box-shadow: -12px 0 32px rgba(0,0,0,.28);
    }
    #bosq.is-docked .bosq-head { cursor: default; }
    #bosq.is-docked .bosq-resize-e, #bosq.is-docked .bosq-resize-s, #bosq.is-docked .bosq-resize-se { display: none; }
    #bosq:not(.is-docked) .bosq-resize-w { display: none; }
    .bosq-head {
      display: flex; align-items: center; gap: 6px; padding: 8px 8px 8px 11px;
      cursor: grab; touch-action: none;
    }
    #bosq.bosq-moving .bosq-head { cursor: grabbing; }
    .bosq-drag {
      flex: 1; display: flex; align-items: center; gap: 7px;
      background: transparent; color: inherit; border: 0; padding: 0; cursor: inherit; text-align: left;
      pointer-events: none;
    }
    .bosq-resize { position: absolute; z-index: 3; touch-action: none; }
    .bosq-resize-w { top: 10px; left: 0; width: 10px; height: calc(100% - 20px); cursor: ew-resize; }
    .bosq-resize-e { top: 10px; right: 0; width: 10px; height: calc(100% - 22px); cursor: ew-resize; }
    .bosq-resize-s { left: 12px; bottom: 0; width: calc(100% - 24px); height: 10px; cursor: ns-resize; }
    .bosq-resize-se {
      right: 2px; bottom: 2px; width: 18px; height: 18px; cursor: nwse-resize;
      background: linear-gradient(135deg, transparent 50%, rgba(231,177,90,.35) 50%);
      border-radius: 0 0 12px 0;
    }
    .bosq-resize-se::after {
      content: ""; position: absolute; right: 5px; bottom: 5px; width: 7px; height: 7px;
      border-right: 2px solid rgba(231,177,90,.75); border-bottom: 2px solid rgba(231,177,90,.75);
      opacity: .85;
    }
    .bosq-markicon { width: 7px; height: 7px; border-radius: 99px; background: #e7b15a; box-shadow: 0 0 0 3px rgba(231,177,90,.14); }
    .bosq-title { font-size: 12px; font-weight: 650; letter-spacing: .01em; }
    .bosq-icon, .bosq-actions button, .bosq-stat {
      border: 1px solid rgba(255,255,255,.08); background: #221f1b; color: #e8e6e1;
      border-radius: 999px; cursor: pointer;
    }
    .bosq-icon { width: 26px; height: 26px; flex: 0 0 26px; }
    .bosq-icon.is-on { border-color: rgba(231,177,90,.7); color: #e7b15a; }
    .bosq-body { display: flex; flex-direction: column; flex: 1; min-height: 0; padding: 0 11px 11px; }
    .bosq-tune { margin: 0 0 8px; padding: 6px 8px; border-radius: 8px; background: rgba(231,177,90,.12); color: #f0d7a4; font-size: 11px; }
    .bosq-hero { padding: 9px 10px; border-radius: 12px; background: linear-gradient(180deg, #2a241c, #211e1a); border: 1px solid rgba(231,177,90,.28); }
    .bosq-hero-kicker { color: #e7b15a; font-size: 9px; font-weight: 700; letter-spacing: .12em; text-transform: uppercase; }
    .bosq-hero-name { margin-top: 3px; font-size: 13px; font-weight: 650; line-height: 1.25; }
    .bosq-hero-meta, .bosq-hero-slack { color: #c9c2b6; font-size: 11px; margin-top: 3px; }
    .bosq-hero-slack { color: #f3f0ea; }
    .bosq-stats { display: grid; grid-template-columns: repeat(5, 1fr); gap: 4px; margin: 8px 0 6px; }
    .bosq-stat { display: flex; flex-direction: column; align-items: flex-start; padding: 6px 8px; border-radius: 10px; }
    .bosq-stat b { font-size: 15px; font-variant-numeric: tabular-nums; }
    .bosq-stat span { color: #a39e94; font-size: 9px; letter-spacing: .08em; text-transform: uppercase; }
    .bosq-stat[data-lens="late"] b { color: #ef4444; }
    .bosq-stat[data-lens="tight"] b { color: #f97316; }
    .bosq-stat[data-lens="blind"] b { color: #8b5cf6; }
    .bosq-stat[data-lens="outsourced"] b { color: #ec4899; }
    .bosq-stat[data-lens="barred"] b { color: #a8a29e; }
    .bosq-stat.is-on[data-lens="late"] { border-color: rgba(239,68,68,.7); }
    .bosq-stat.is-on[data-lens="tight"] { border-color: rgba(249,115,22,.7); }
    .bosq-stat.is-on[data-lens="blind"] { border-color: rgba(139,92,246,.7); }
    .bosq-stat.is-on[data-lens="outsourced"] { border-color: rgba(236,72,153,.7); }
    .bosq-stat.is-on[data-lens="barred"] { border-color: rgba(168,162,158,.75); }
    .bosq-legend {
      display: flex; flex-wrap: wrap; gap: 8px 10px; margin: 0 0 6px;
      color: #a39e94; font-size: 10px;
    }
    .bosq-legend span { display: inline-flex; align-items: center; gap: 5px; }
    .bosq-legend i {
      width: 8px; height: 8px; border-radius: 99px; display: inline-block;
    }
    .bosq-legend [data-band="late"] i { background: #ef4444; }
    .bosq-legend [data-band="tight"] i { background: #f97316; }
    .bosq-legend [data-band="blind"] i { background: #8b5cf6; }
    .bosq-legend [data-band="outsourced"] i { background: #ec4899; }
    .bosq-legend [data-band="barred"] i { background: #78716c; }
    .bosq-sensitivity { min-height: 14px; margin: 0 0 6px; color: #a39e94; font-size: 10px; }
    .bosq-tools { display: grid; grid-template-columns: 1fr; gap: 5px; }
    .bosq-board-acts { display: grid; grid-template-columns: 1fr 1fr; gap: 5px; margin-top: 5px; }
    .bosq-board-acts button {
      padding: 6px 7px; border-radius: 9px; border: 1px solid rgba(255,255,255,.08);
      background: #221f1b; color: #e8e6e1; font: inherit; font-size: 10px; cursor: pointer;
    }
    .bosq-board-acts button:hover { background: #2d2924; border-color: rgba(231,177,90,.35); }
    .bosq-tools select, .bosq-tools input, .bosq-grid input {
      width: 100%; background: #100f0d; color: #f3f0ea; border: 1px solid rgba(255,255,255,.08);
      border-radius: 9px; padding: 6px 8px; font: inherit;
    }
    .bosq-list { overflow: auto; margin-top: 8px; padding-right: 2px; min-height: 72px; flex: 1; }
    .bosq-list section { margin-bottom: 10px; }
    .bosq-list h3 { margin: 0; font-size: 10px; letter-spacing: .08em; text-transform: uppercase; color: #f3f0ea; }
    .bosq-list section > p, .bosq-fine { margin: 2px 0 6px; color: #8f8a82; font-size: 10px; }
    .bosq-card {
      width: 100%; display: flex; flex-direction: column; gap: 4px; text-align: left;
      margin: 0 0 5px; padding: 7px 7px 7px 10px; border-radius: 10px;
      border: 1px solid rgba(255,255,255,.06); background: #201d19; color: inherit;
      box-shadow: inset 2px 0 0 #6f6a62;
    }
    .bosq-card-top { display: flex; gap: 5px; align-items: flex-start; }
    .bosq-card-jump {
      flex: 1; display: flex; flex-direction: column; gap: 1px; text-align: left;
      background: transparent; border: 0; color: inherit; padding: 0; cursor: pointer; font: inherit;
    }
    .bosq-card-jump:hover .bosq-card-name { color: #f8f4ec; }
    .bosq-card-acts { display: flex; flex-direction: column; gap: 3px; }
    .bosq-os, .bosq-bar-btn, .bosq-more {
      min-width: 26px; height: 22px; padding: 0 5px; border-radius: 7px; font: 9px/1 "Segoe UI", sans-serif;
      letter-spacing: .04em; text-transform: uppercase; cursor: pointer;
      border: 1px solid rgba(255,255,255,.1); background: #2a2621; color: #c9c2b6;
    }
    .bosq-os.is-on { background: rgba(236,72,153,.2); border-color: rgba(236,72,153,.7); color: #f9a8d4; }
    .bosq-bar-btn.is-on { background: rgba(120,113,108,.28); border-color: rgba(168,162,158,.75); color: #e7e5e4; }
    .bosq-part-acts { display: flex; flex-direction: column; gap: 3px; flex-shrink: 0; }
    .bosq-card-name { font-weight: 650; line-height: 1.25; }
    .bosq-card-meta, .bosq-card-time, .bosq-card-extra, .bosq-card-cue { color: #b7b1a7; font-size: 10px; }
    .bosq-card-time { color: #f3f0ea; }
    .bosq-card-cue { color: #e7b15a; }
    .bosq-card[data-band="late"] { box-shadow: inset 2px 0 0 #ef4444; }
    .bosq-card[data-band="tight"] { box-shadow: inset 2px 0 0 #f97316; }
    .bosq-card[data-band="blind"], .bosq-card[data-band="nodate"] { box-shadow: inset 2px 0 0 #8b5cf6; }
    .bosq-card[data-band="parked"] { box-shadow: inset 2px 0 0 #64748b; }
    .bosq-card[data-band="held"] { box-shadow: inset 2px 0 0 #8a847b; }
    .bosq-card[data-band="ok"] { box-shadow: inset 2px 0 0 #84cc16; }
    .bosq-card[data-band="outsourced"] { box-shadow: inset 2px 0 0 #ec4899; }
    .bosq-card[data-band="barred"] { box-shadow: inset 2px 0 0 #78716c; }
    .bosq-parts { display: flex; flex-direction: column; gap: 3px; padding: 3px 1px 1px; }
    .bosq-parts > p, .bosq-parts-empty { margin: 0 0 3px; color: #8f8a82; font-size: 10px; }
    .bosq-part { display: flex; gap: 5px; align-items: flex-start; padding: 5px 7px; border-radius: 8px; background: #181614; }
    .bosq-part-body {
      flex: 1; display: flex; flex-direction: column; gap: 1px; background: transparent; border: 0; color: inherit;
      padding: 0; text-align: left; font: inherit; cursor: pointer;
    }
    .bosq-part-body:hover .bosq-part-name { color: #f8f4ec; }
    .bosq-part-tag { font-size: 8px; font-weight: 700; letter-spacing: .08em; text-transform: uppercase; color: #a39e94; }
    .bosq-part-tag[data-tag="first"] { color: #e7b15a; }
    .bosq-part-tag[data-tag="late"] { color: #f87171; }
    .bosq-part-tag[data-tag="tight"] { color: #fb923c; }
    .bosq-part-tag[data-tag="blind"] { color: #c4b5fd; }
    .bosq-part-tag[data-tag="outsourced"] { color: #f9a8d4; }
    .bosq-part-name { font-size: 11px; font-weight: 650; }
    .bosq-part-clock { font-size: 10px; color: #b7b1a7; }
    .bosq-part[data-band="late"] { box-shadow: inset 2px 0 0 #ef4444; }
    .bosq-part[data-band="tight"] { box-shadow: inset 2px 0 0 #f97316; }
    .bosq-part[data-band="blind"] { box-shadow: inset 2px 0 0 #8b5cf6; }
    .bosq-part[data-band="outsourced"] { box-shadow: inset 2px 0 0 #ec4899; opacity: .9; }
    .bosq-part[data-band="barred"] { box-shadow: inset 2px 0 0 #78716c; opacity: .88; }
    .bosq-part-tag[data-tag="barred"] { color: #d6d3d1; }
    .bosq-part[data-band="ok"] { box-shadow: inset 2px 0 0 #84cc16; }
    .bosq-mat { display: grid; grid-template-columns: 64px 1fr auto; gap: 8px; align-items: center; font-size: 11px; margin-bottom: 4px; }
    .bosq-bar { height: 5px; border-radius: 99px; background: #100f0d; overflow: hidden; }
    .bosq-bar i { display: block; height: 100%; background: #e7b15a; }
    .bosq-settings { margin-top: 4px; }
    .bosq-settings summary { cursor: pointer; color: #c9c2b6; font-size: 11px; }
    .bosq-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 7px; margin-top: 8px; }
    .bosq-grid label, .bosq-check { display: flex; flex-direction: column; gap: 3px; color: #a39e94; font-size: 10px; }
    .bosq-check { flex-direction: row; align-items: center; gap: 7px; margin-top: 7px; color: #e8e6e1; font-size: 11px; }
    .bosq-actions { display: flex; gap: 5px; margin: 8px 0; }
    .bosq-actions button { padding: 5px 9px; font: inherit; }
    .bosq-empty { color: #a39e94; padding: 10px 2px; }
    tr[data-bosq-band] > td { transition: background-color 0.12s ease, box-shadow 0.12s ease; }
    tr[data-bosq-band="late"] > td {
      box-shadow: inset 3px 0 0 #ef4444;
      background-color: rgba(239, 68, 68, 0.1) !important;
    }
    tr[data-bosq-band="tight"] > td {
      box-shadow: inset 3px 0 0 #f97316;
      background-color: rgba(249, 115, 22, 0.1) !important;
    }
    tr[data-bosq-band="blind"] > td,
    tr[data-bosq-band="nodate"] > td {
      box-shadow: inset 3px 0 0 #8b5cf6;
      background-color: rgba(139, 92, 246, 0.1) !important;
    }
    tr[data-bosq-band="parked"] > td {
      box-shadow: inset 3px 0 0 #64748b;
      background-color: rgba(100, 116, 139, 0.1) !important;
    }
    tr[data-bosq-band="held"] > td {
      box-shadow: inset 3px 0 0 #94a3b8;
      background-color: rgba(100, 116, 139, 0.12) !important;
    }
    tr[data-bosq-band="ok"] > td {
      box-shadow: inset 3px 0 0 #84cc16;
      background-color: rgba(132, 204, 22, 0.07) !important;
    }
    html[data-theme="dark"] tr[data-bosq-band="late"] > td { background-color: rgba(239, 68, 68, 0.14) !important; }
    html[data-theme="dark"] tr[data-bosq-band="tight"] > td { background-color: rgba(249, 115, 22, 0.12) !important; }
    html[data-theme="dark"] tr[data-bosq-band="blind"] > td,
    html[data-theme="dark"] tr[data-bosq-band="nodate"] > td { background-color: rgba(139, 92, 246, 0.12) !important; }
    html[data-theme="dark"] tr[data-bosq-band="parked"] > td { background-color: rgba(100, 116, 139, 0.12) !important; }
    html[data-theme="dark"] tr[data-bosq-band="held"] > td { background-color: rgba(148, 163, 184, 0.1) !important; }
    html[data-theme="dark"] tr[data-bosq-band="ok"] > td { background-color: rgba(163, 230, 53, 0.08) !important; }
    tr[data-bosq-band="outsourced"] > td {
      box-shadow: inset 3px 0 0 #ec4899;
      background-color: rgba(236, 72, 153, 0.1) !important;
    }
    html[data-theme="dark"] tr[data-bosq-band="outsourced"] > td { background-color: rgba(236, 72, 153, 0.12) !important; }
    tr[data-bosq-band="barred"] > td {
      box-shadow: inset 3px 0 0 #78716c;
      background-color: rgba(120, 113, 108, 0.12) !important;
    }
    html[data-theme="dark"] tr[data-bosq-band="barred"] > td { background-color: rgba(168, 162, 158, 0.1) !important; }
    tr[data-bosq-part-band] > td { transition: background-color 0.12s ease, box-shadow 0.12s ease; }
    tr[data-bosq-part-band="late"] > td { box-shadow: inset 3px 0 0 #ef4444; background-color: rgba(239, 68, 68, 0.08) !important; }
    tr[data-bosq-part-band="tight"] > td { box-shadow: inset 3px 0 0 #f97316; background-color: rgba(249, 115, 22, 0.08) !important; }
    tr[data-bosq-part-band="blind"] > td { box-shadow: inset 3px 0 0 #8b5cf6; background-color: rgba(139, 92, 246, 0.08) !important; }
    tr[data-bosq-part-band="ok"] > td { box-shadow: inset 3px 0 0 #84cc16; background-color: rgba(132, 204, 22, 0.05) !important; }
    tr[data-bosq-part-band="outsourced"] > td { box-shadow: inset 3px 0 0 #ec4899; background-color: rgba(236, 72, 153, 0.08) !important; }
    tr[data-bosq-part-band="barred"] > td { box-shadow: inset 3px 0 0 #78716c; background-color: rgba(120, 113, 108, 0.08) !important; }
    tr.bosq-dim { opacity: .45; }
    tr.bosq-flash { position: relative; z-index: 2; }
    tr.bosq-flash > td {
      animation: bosq-flash-pulse 0.25s ease-in-out 5 !important;
    }
    .bosq-row-beacon {
      position: fixed;
      z-index: 2147483000;
      pointer-events: none;
      border-radius: 8px;
      box-sizing: border-box;
      border: 3px solid #facc15;
      background: rgba(250, 204, 21, 0.14);
      animation: bosq-beacon-pulse 0.26s ease-in-out 5;
    }
    @keyframes bosq-beacon-pulse {
      0%, 100% {
        opacity: 0.225;
        border-color: #eab308;
        background: rgba(234, 179, 8, 0.09);
        box-shadow: 0 0 0 0 rgba(250, 204, 21, 0.2), 0 0 16px 2px rgba(250, 204, 21, 0.175);
      }
      50% {
        opacity: 0.5;
        border-color: #fef08a;
        background: rgba(254, 240, 138, 0.21);
        box-shadow: 0 0 0 6px rgba(250, 204, 21, 0.275), 0 0 28px 8px rgba(250, 204, 21, 0.425);
      }
    }
    .bosq-farm { margin-top: 2px; font-size: 10px; line-height: 1.25; font-weight: 650; text-align: center; color: #d6d3d1; }
    .bosq-farm[data-band="late"] { color: #f87171; }
    .bosq-farm[data-band="tight"] { color: #fb923c; }
    .bosq-farm[data-band="blind"], .bosq-farm[data-band="nodate"] { color: #c4b5fd; }
    .bosq-farm[data-band="parked"] { color: #94a3b8; }
    .bosq-farm[data-band="held"] { color: #e7e5e4; }
    .bosq-farm[data-band="ok"] { color: #d9f99d; }
    .bosq-farm[data-band="outsourced"] { color: #f9a8d4; }
    .bosq-farm[data-band="barred"] { color: #d6d3d1; }
    @keyframes bosq-flash-pulse {
      0%, 100% {
        background-color: inherit !important;
        filter: none;
      }
      50% {
        background-color: rgba(254, 240, 138, 0.275) !important;
        filter: brightness(1.06);
      }
    }
  `;

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", boot);
  else boot();
})();
