// --- CONFIG ---
const TARGET_LANG = "en";
const SITE_REGEX = null; // set to a regex to restrict domains
const PROCESSED_ATTR = "data-ttt-processed";
const TEST_MODE = false; // leave false for real translation
const MAX_CONCURRENCY = 16; // <-- controla cuÃ¡ntas traducciones paralelas a la vez

const translateCache = new Map();
console.log("[TRANSLATECHANGER] content script loaded");

// --- CJK DETECTOR ---
function hasCJK(str) {
  return /[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/.test(str);
}
function paintHighlight(el) {
    el.classList.add("ttt-translated");
    // In case of specificity wars with site CSS:
    el.style.setProperty("color", "#fbeb77", "important");
  }
  
  
  function ensureHighlightStyle() {
    const id = "ttt-highlight-style";
    let style = document.getElementById(id);
    if (style) return;
    style = document.createElement("style");
    style.id = id;
    style.textContent = `
      .ttt-translated {
        color: #fbeb77 !important; /* requested highlight color */
      }
    `;
    document.documentElement.appendChild(style);
    console.log("[TRANSLATECHANGER] injected .ttt-translated style (#fbeb77)");
  }
  ensureHighlightStyle();
  

function textHash(s) {
    // tiny fast hash (not crypto), good enough to detect changes
    let h = 0;
    for (let i = 0; i < s.length; i++) {
      h = (h * 31 + s.charCodeAt(i)) | 0;
    }
    return String(h);
  }

  // Is this text likely to be a ticker?
function looksLikeTicker(txt) {
    // Tickers are often short, mostly A-Z0-9 (allow a few symbols)
    return /^[A-Z0-9._-]{2,12}$/.test(txt);
  }
  
  // Rank function: higher is better
  function rankNodeText(txt) {
    let score = 0;
    if (hasCJK(txt)) score += 100;       // we must translate these
    if (looksLikeTicker(txt)) score += 50; // likely the ticker
    // shorter names slightly preferred (less noise)
    score += Math.max(0, 20 - Math.min(20, txt.length));
    return score;
  }
  
  

// Heuristic: find short text nodes that look like name/ticker
function findCandidateTextNodes(rowEl) {
    const leafs = rowEl.querySelectorAll("div,span,a");
    const items = [];
    const seenText = new Set();
  
    leafs.forEach(el => {
      if (el.hasAttribute(PROCESSED_ATTR)) return;
      if (el.children.length > 0) return;
  
      const txt = (el.textContent || "").trim();
      if (!txt) return;
  
      // Skip obvious numbers/addresses/money
      if (/^0x[0-9a-fA-F]{4,}$/.test(txt)) return;
      if (/^\$?\d/.test(txt)) return;
      if (/^\d+(\.\d+)?[KMB]?$/.test(txt)) return;
  
      if (txt.length > 40) return;
  
      // Deduplicate by text so name duplicated twice doesn't use both slots
      if (seenText.has(txt)) return;
      seenText.add(txt);
  
      const score = rankNodeText(txt);
      items.push({ el, txt, score });
    });
  
    // Sort by score DESC and keep the top few
    items.sort((a, b) => b.score - a.score);
  
    const chosen = items.slice(0, 4).map(i => i.el);
    console.log("[TRANSLATECHANGER] findCandidateTextNodes ->",
      items.length, "candidates; chosen:", chosen.map(n => n.textContent?.trim()));
    return chosen;
  }
  
// --- Single translation with cache ---
async function translateText(text, targetLang = TARGET_LANG) {
  const key = `${targetLang}:${text}`;
  if (translateCache.has(key)) {
    console.log("[TRANSLATECHANGER] cache hit:", text, "->", translateCache.get(key));
    return translateCache.get(key);
  }
  if (!hasCJK(text)) {
    console.log("[TRANSLATECHANGER] non-CJK, leaving as-is:", text);
    translateCache.set(key, text);
    return text;
  }

  const url =
    `https://translate.googleapis.com/translate_a/single` +
    `?client=gtx&sl=auto&tl=${encodeURIComponent(targetLang)}&dt=t&q=${encodeURIComponent(text)}`;

  console.log("[TRANSLATECHANGER] fetching translation:", { text, targetLang, url });
  try {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    const translated = (data?.[0] || []).map(seg => (Array.isArray(seg) ? seg[0] : "")).join("").trim();
    const finalText = translated || text;
    console.log("[TRANSLATECHANGER] translated:", { original: text, translated: finalText });
    translateCache.set(key, finalText);
    return finalText;
  } catch (e) {
    console.warn("[TRANSLATECHANGER] translate error, using original:", text, e);
    translateCache.set(key, text);
    return text;
  }
}

// --- Concurrency-limited runner ---
async function runWithConcurrency(items, worker, limit = MAX_CONCURRENCY) {
  let idx = 0;
  let active = 0;
  return await new Promise(resolve => {
    const results = new Array(items.length);
    const next = () => {
      while (active < limit && idx < items.length) {
        const cur = idx++;
        active++;
        Promise.resolve(worker(items[cur], cur))
          .then(r => { results[cur] = r; })
          .catch(err => { results[cur] = undefined; console.warn("[TRANSLATECHANGER] worker error", err); })
          .finally(() => { active--; (idx >= items.length && active === 0) ? resolve(results) : next(); });
      }
    };
    next();
  });
}

// --- Batch unique CJK translations in parallel ---
async function translateManyUniqueCJK(strings) {
  // Dedup + keep order
  const uniq = [];
  const seen = new Set();
  for (const s of strings) {
    if (!hasCJK(s)) continue;
    if (!seen.has(s)) { seen.add(s); uniq.push(s); }
  }
  console.log("[TRANSLATECHANGER] translateManyUniqueCJK uniq:", uniq.length, uniq);

  const outMap = new Map();
  if (uniq.length === 0) return outMap;

  await runWithConcurrency(uniq, async (s) => {
    const t = await translateText(s);
    outMap.set(s, t);
  }, MAX_CONCURRENCY);

  return outMap;
}

// Selector for rows
function looksLikeRow(el) {
  if (!(el instanceof HTMLElement)) return false;
  const isDirect = el.matches('div[href*="/token/"], div[href*="/bsc/token/"], div[href*="/sol/token/"], div[href*="/eth/token/"]');
  const nested = !isDirect && !!el.querySelector('div[href*="/token/"], div[href*="/bsc/token/"], div[href*="/sol/token/"], div[href*="/eth/token/"]');
  const ok = isDirect || nested;
  if (ok) console.log("[TRANSLATECHANGER] looksLikeRow YES (href match):", el);
  return ok;
}

// --- Process one row with parallel translations ---
async function processRow(rowEl) {
  if (!rowEl || rowEl.nodeType !== 1) return;

  if (!rowEl.getAttribute("data-ttt-rowid")) {
    rowEl.setAttribute("data-ttt-rowid", Math.random().toString(36).slice(2, 7));
  }
  const rowId = rowEl.getAttribute("data-ttt-rowid");
  console.log("[TRANSLATECHANGER] processRow start:", { rowId, rowEl });

  // first two short labels (name + ticker). Tweak slice if needed.
  const nodes = findCandidateTextNodes(rowEl)
    .filter(el => (el.textContent || "").trim().length <= 20)
    .slice(0, 2);

  const originals = nodes.map(n => (n.textContent || "").trim());
  console.log("[TRANSLATECHANGER] nodes chosen:", nodes.length, originals);

  // TEST mode early exit
  if (TEST_MODE) {
    nodes.forEach((el, i) => {
      const original = originals[i];
      el.textContent = `[TEST] ${original}`;
      el.setAttribute(PROCESSED_ATTR, "1");
      if (!el.getAttribute("title")) el.setAttribute("title", original);
      console.log("[TRANSLATECHANGER] TEST_MODE wrote:", el.textContent);
    });
    console.log("[TRANSLATECHANGER] processRow done (TEST_MODE):", { rowId, processed: nodes.length });
    return;
  }

  // Kick parallel translations for unique CJK only
  const cjkMap = await translateManyUniqueCJK(originals);

  let processed = 0;
await Promise.all(nodes.map(async (el, i) => {
  const original = (el.textContent || "").trim();
  const currentHash = textHash(original);
  const prevHash = el.getAttribute("data-ttt-hash");

  // If text changed since our last run, clear flags
  if (prevHash && prevHash !== currentHash) {
    el.removeAttribute(PROCESSED_ATTR);
    el.removeAttribute("data-ttt-translated");
    el.classList.remove("ttt-translated");
  }

  if (el.getAttribute(PROCESSED_ATTR) === "1") {
    // Re-assert green if it was translated before but CSS got reset
    if (el.getAttribute("data-ttt-translated") === "1") {
        paintHighlight(el);
    }
    console.log("[TRANSLATECHANGER] skip already processed node");
    return;
  }

  const isCJK = hasCJK(original);
  const nextText = TEST_MODE
    ? `[TEST] ${original}`
    : (isCJK ? (cjkMap.get(original) ?? original) : original);

  if (nextText !== original) {
    // We performed a translation (or test mode) -> paint & tag
    el.textContent = nextText;
    paintHighlight(el);
    el.setAttribute("data-ttt-translated", "1");
    console.log("[TRANSLATECHANGER] wrote translation:", { original, translated: nextText });
  } else {
    // Not translating now. But if we *previously* translated this node (or
    // we left a CJK 'title' as provenance), re-apply green.
    if (el.getAttribute("data-ttt-translated") === "1" || (el.getAttribute("title") && hasCJK(el.getAttribute("title")))) {
        paintHighlight(el);
        console.log("[TRANSLATECHANGER] re-applied green to previously translated node:", original);
    } else {
      console.log("[TRANSLATECHANGER] no change:", original);
    }
  }

  el.setAttribute(PROCESSED_ATTR, "1");
  el.setAttribute("data-ttt-hash", currentHash);
  if (!el.getAttribute("title")) el.setAttribute("title", original);
  processed++;
}));

}

// --- Scanning / Observer remain the same ---
async function initialScan() {
  if (SITE_REGEX && !SITE_REGEX.test(location.href)) {
    console.log("[TRANSLATECHANGER] SITE_REGEX blocked run on this URL:", location.href);
    return;
  }
  console.log("[TRANSLATECHANGER] initialScan start");

  const candidates = document.querySelectorAll(
    'div[href*="/token/"], div[href*="/bsc/token/"], div[href*="/sol/token/"], div[href*="/eth/token/"], ' +
    'div:has(> div[href*="/token/"]), div:has(> div[href*="/bsc/token/"]), ' +
    'div:has(> div[href*="/sol/token/"]), div:has(> div[href*="/eth/token/"])'
  );

  const allRows = Array.from(candidates).filter(looksLikeRow);
  console.log("[TRANSLATECHANGER] initialScan candidates:", candidates.length, "filtered rows:", allRows.length);

  for (const row of allRows) processRow(row);
  console.log("[TRANSLATECHANGER] initialScan end");
}

function installObserver() {
    console.log("[TRANSLATECHANGER] installing MutationObserver");
  
    const debouncePerRow = new Map();
    const reprocessRowSoon = (rowEl, why) => {
      const rowId = rowEl.getAttribute("data-ttt-rowid") || Math.random().toString(36).slice(2, 7);
      rowEl.setAttribute("data-ttt-rowid", rowId);
      if (debouncePerRow.has(rowId)) clearTimeout(debouncePerRow.get(rowId));
      debouncePerRow.set(rowId, setTimeout(() => {
        console.log("[TRANSLATECHANGER] reprocess row due to", why, "rowId:", rowId);
        processRow(rowEl);
        debouncePerRow.delete(rowId);
      }, 40));
    };
  
    const observer = new MutationObserver(mutations => {
      for (const m of mutations) {
        if (m.type === "childList") {
          m.addedNodes.forEach(node => {
            if (!(node instanceof HTMLElement)) return;
            if (looksLikeRow(node)) {
              console.log("[TRANSLATECHANGER] observed new row (direct child)");
              processRow(node);
            } else {
              const innerRows = node.querySelectorAll ? node.querySelectorAll("div") : [];
              innerRows.forEach(el => {
                if (looksLikeRow(el)) {
                  console.log("[TRANSLATECHANGER] observed new row (descendant)");
                  processRow(el);
                }
              });
            }
          });
        }
  
        if (m.type === "characterData") {
          const tn = m.target;
          const el = tn.parentElement;
          if (!el) continue;
          // if leaf text changes, clear processed + hash so we translate again
          el.removeAttribute(PROCESSED_ATTR);
          el.removeAttribute("data-ttt-hash");
          const rowEl =
            el.closest('div[href*="/token/"], div[href*="/bsc/token/"], div[href*="/sol/token/"], div[href*="/eth/token/"]') ||
            el.closest("div");
          if (rowEl && looksLikeRow(rowEl)) reprocessRowSoon(rowEl, "characterData");
        }
  
        if (m.type === "attributes") {
          const target = /** @type {HTMLElement} */ (m.target);
          if (!(target instanceof HTMLElement)) continue;
          const rowEl =
            target.closest('div[href*="/token/"], div[href*="/bsc/token/"], div[href*="/sol/token/"], div[href*="/eth/token/"]') ||
            target.closest("div");
          if (rowEl && looksLikeRow(rowEl)) reprocessRowSoon(rowEl, `attr:${m.attributeName}`);
        }
      }
    });
  
    observer.observe(document.documentElement, {
      childList: true,
      subtree: true,
      characterData: true,
      attributes: true,
      attributeFilter: ["class", "style", "href", "data-index"]
    });
  
    console.log("[TRANSLATECHANGER] MutationObserver active");
  }
  
function throttle(fn, wait = 300) {
  let last = 0, timer = null;
  return (...args) => {
    const now = Date.now();
    const remaining = wait - (now - last);
    if (remaining <= 0) {
      clearTimeout(timer); timer = null; last = now; fn(...args);
    } else if (!timer) {
      timer = setTimeout(() => { last = Date.now(); timer = null; fn(...args); }, remaining);
    }
  };
}

(function main() {
  if (SITE_REGEX && !SITE_REGEX.test(location.href)) {
    console.log("[TRANSLATECHANGER] main aborted by SITE_REGEX");
    return;
  }
  console.log("[TRANSLATECHANGER] main start on", location.href);
  initialScan();
  installObserver();
  installIntersectionObserver(); // optional perf booster

  window.addEventListener("scroll", throttle(() => {
    console.log("[TRANSLATECHANGER] throttled scroll -> rescan");
    initialScan();
  }, 300), { passive: true });

  // quick retry loop on first load
  let tries = 0; const maxTries = 10;
  const tick = async () => {
    tries++; console.log("[TRANSLATECHANGER] retryInitial attempt", tries);
    await initialScan();
    if (tries < maxTries) setTimeout(tick, 500);
  };
  setTimeout(tick, 300);

  console.log("[TRANSLATECHANGER] translator running (TEST_MODE:", TEST_MODE, ", MAX_CONCURRENCY:", MAX_CONCURRENCY, ")");
})();