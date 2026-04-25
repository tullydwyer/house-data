(() => {
  const ROOT_ID = "house-lens-root";
  const STORE_KEY = "houseLensListings";
  const MAX_SCRIPT_CHARS = 450000;
  const MAX_STORED_SNAPSHOTS = 40;

  const DEFAULT_SETTINGS = {
    overlayEnabled: true
  };

  chrome.storage.sync.get(DEFAULT_SETTINGS, (settings) => {
    if (!settings.overlayEnabled) return;
    boot();
  });

  function boot() {
    const run = debounce(async () => {
      const listing = collectListing();
      if (!listing) {
        annotateSearchCards();
        return;
      }

      const history = await saveSnapshot(listing);
      injectPanel(listing, history);
      chrome.runtime.sendMessage({ type: "HOUSE_LENS_SYNC_SNAPSHOT", payload: listing });
    }, 250);

    run();

    let lastHref = location.href;
    const observer = new MutationObserver(() => {
      if (location.href !== lastHref) {
        lastHref = location.href;
        run();
        return;
      }

      if (!document.querySelector(`#${ROOT_ID}`)) run();
    });

    observer.observe(document.documentElement, { childList: true, subtree: true });
  }

  function collectListing() {
    const portal = getPortal();
    if (!portal) return null;

    const title = cleanText(
      pickText([
        "h1",
        "[data-testid*='listing-title']",
        "[data-testid*='property-title']",
        "meta[property='og:title']",
        "title"
      ])
    );
    const address = getAddress(title);
    const listingId = getListingId();
    const displayedPrice = findDisplayedPrice();
    const status = findStatus();
    const searchRange = getSearchRangeFromUrl();
    const jsonSignals = findJsonSignals();
    const hiddenRange = chooseHiddenRange(jsonSignals.priceSignals, displayedPrice, searchRange);
    const agent = findAgent(jsonSignals.textSignals);
    const agency = findAgency(jsonSignals.textSignals);
    const rent = chooseRent(jsonSignals.priceSignals);
    const estimate = chooseEstimate(jsonSignals.priceSignals, hiddenRange);

    const hasListingShape =
      listingId ||
      address ||
      displayedPrice ||
      hiddenRange ||
      isPropertyListingPath() ||
      /\/sale\/|\/buy\/|\/rent\/|\/sold\//i.test(location.pathname);

    if (!hasListingShape) return null;

    const stableId = listingId || hashString(`${portal}:${address || title || location.pathname}`);
    const now = new Date().toISOString();

    return {
      id: `${portal}:${stableId}`,
      portal,
      url: location.href,
      listingId: stableId,
      title: title || address || document.title,
      address,
      displayedPrice,
      hiddenRange,
      searchRange,
      status,
      agent,
      agency,
      rent,
      estimate,
      firstSeenAt: now,
      seenAt: now,
      signals: jsonSignals.priceSignals.slice(0, 25)
    };
  }

  function getPortal() {
    const host = location.hostname;
    if (host.includes("domain.com.au")) return "domain";
    if (host.includes("realestate.com.au")) return "realestate";
    if (host.includes("allhomes.com.au")) return "allhomes";
    return "";
  }

  function getListingId() {
    const candidates = [
      location.pathname.match(/-(\d{5,})(?:\/)?$/),
      location.pathname.match(/(?:property-|listing-|ad-)[a-z-]*?(\d{5,})/i),
      location.href.match(/[?&](?:listingId|adId|propertyId)=(\d{5,})/i),
      cleanText(document.body?.textContent).match(/\bProperty ID:\s*(\d{5,})\b/i)
    ];

    for (const match of candidates) {
      if (match?.[1]) return match[1];
    }

    const canonical = querySelectorSafe("link[rel='canonical']")?.href || "";
    const canonicalMatch = canonical.match(/(\d{5,})(?:\/)?$/);
    return canonicalMatch?.[1] || "";
  }

  function pickText(selectors) {
    for (const selector of selectors) {
      const element = querySelectorSafe(selector);
      if (!element) continue;
      const value = element.tagName === "META" ? element.content : element.textContent;
      if (cleanText(value)) return value;
    }
    return "";
  }

  function getAddress(title) {
    const direct = cleanText(
      pickText([
        "[data-testid*='address']",
        "[data-testid*='listing-address']",
        "[aria-label*='address' i]",
        "meta[property='og:street-address']"
      ])
    );
    if (direct) return direct;

    const jsonLd = querySelectorAllSafe("script[type='application/ld+json']")
      .map((script) => parseJson(script.textContent))
      .filter(Boolean);

    for (const item of jsonLd) {
      const address = item?.address || item?.["@graph"]?.find?.((entry) => entry.address)?.address;
      const formatted = formatAddress(address);
      if (formatted) return formatted;
    }

    return cleanText(title?.split("|")?.[0]?.replace(/\b(property|house|apartment|unit)\b.*$/i, ""));
  }

  function formatAddress(address) {
    if (!address) return "";
    if (typeof address === "string") return cleanText(address);
    return cleanText(
      [
        address.streetAddress,
        address.addressLocality,
        address.addressRegion,
        address.postalCode
      ].filter(Boolean).join(", ")
    );
  }

  function findDisplayedPrice() {
    const selectors = [
      "[data-testid*='listing-price']",
      "[data-testid*='price']",
      "[class*='price' i]",
      "h1 + div",
      "h2"
    ];

    for (const selector of selectors) {
      for (const node of querySelectorAllSafe(selector)) {
        const text = cleanText(node.textContent);
        if (looksLikePriceText(text)) return text;
      }
    }

    return findVisibleText((text) => /^price guide\b/i.test(text) || looksLikePriceText(text));
  }

  function findStatus() {
    const text = findVisibleText((value) => /\b(auction|sold|under offer|for sale|private sale|passed in|withdrawn)\b/i.test(value));
    return cleanText(text);
  }

  function findAgent(textSignals) {
    const direct = cleanText(
      pickText([
        "[data-testid*='agent-name']",
        "[class*='agent' i] [class*='name' i]",
        "[aria-label*='agent' i]"
      ])
    );
    if (direct && direct.length < 80) return direct;

    return chooseTextSignal(textSignals, /(agent|agentName|salesAgent|lister)/i);
  }

  function findAgency(textSignals) {
    const direct = cleanText(
      pickText([
        "[data-testid*='agency']",
        "[data-testid*='brand']",
        "[class*='agency' i]",
        "[class*='agent' i] img[alt]"
      ])
    );
    if (direct && direct.length < 100) return direct;

    return chooseTextSignal(textSignals, /(agency|agencyName|office|brandName)/i);
  }

  function findVisibleText(predicate) {
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    let count = 0;
    while (walker.nextNode() && count < 3500) {
      count += 1;
      const text = cleanText(walker.currentNode.nodeValue);
      if (!text || text.length > 180) continue;
      const parent = walker.currentNode.parentElement;
      if (!parent || parent.offsetParent === null) continue;
      if (predicate(text)) return text;
    }
    return "";
  }

  function getSearchRangeFromUrl() {
    const params = new URLSearchParams(location.search);
    const min = firstParam(params, ["price-min", "priceMin", "minPrice", "priceFrom", "min"]);
    const max = firstParam(params, ["price-max", "priceMax", "maxPrice", "priceTo", "max"]);
    const range = firstParam(params, ["price", "priceRange"]);

    if (min || max) return formatRange(min, max);
    if (range && /\d/.test(range)) return cleanText(range);
    return "";
  }

  function firstParam(params, keys) {
    for (const key of keys) {
      const value = params.get(key);
      if (value) return value;
    }
    return "";
  }

  function findJsonSignals() {
    const priceSignals = [];
    const textSignals = [];
    const seen = new Set();

    for (const script of document.scripts) {
      const text = script.textContent || "";
      if (!text || text.length > MAX_SCRIPT_CHARS) continue;

      if (script.type.includes("json")) {
        const parsed = parseJson(text);
        if (parsed) walkData(parsed, "", priceSignals, textSignals, seen);
      }

      findRegexSignals(text, priceSignals, textSignals, seen);
    }

    return { priceSignals, textSignals };
  }

  function findRegexSignals(text, priceSignals, textSignals, seen) {
    const pricePattern = /"([^"]*(?:price|guide|range|rent|estimate)[^"]*)"\s*:\s*("[^"]{1,100}"|\d{4,9})/gi;
    let match;
    while ((match = pricePattern.exec(text)) && priceSignals.length < 120) {
      const key = match[1];
      const rawValue = match[2].replace(/^"|"$/g, "");
      addPriceSignal(priceSignals, seen, key, rawValue);
    }

    const textPattern = /"([^"]*(?:agent|agency|office|brand)[^"]*)"\s*:\s*"([^"]{2,90})"/gi;
    while ((match = textPattern.exec(text)) && textSignals.length < 80) {
      addTextSignal(textSignals, seen, match[1], match[2]);
    }
  }

  function walkData(value, path, priceSignals, textSignals, seen) {
    if (priceSignals.length > 120 && textSignals.length > 80) return;
    if (!value || typeof value !== "object") return;

    if (Array.isArray(value)) {
      value.slice(0, 80).forEach((entry, index) => walkData(entry, `${path}[${index}]`, priceSignals, textSignals, seen));
      return;
    }

    for (const [key, child] of Object.entries(value)) {
      const nextPath = path ? `${path}.${key}` : key;
      if (/price|guide|range|rent|estimate/i.test(key) && (typeof child === "string" || typeof child === "number")) {
        addPriceSignal(priceSignals, seen, nextPath, child);
      }
      if (/agent|agency|office|brand/i.test(key) && typeof child === "string") {
        addTextSignal(textSignals, seen, nextPath, child);
      }
      if (child && typeof child === "object") walkData(child, nextPath, priceSignals, textSignals, seen);
    }
  }

  function addPriceSignal(target, seen, key, value) {
    const label = cleanText(String(key));
    const display = cleanText(String(value));
    if (!display || !/\d/.test(display)) return;
    const id = `${label}:${display}`;
    if (seen.has(id)) return;
    seen.add(id);
    target.push({ label, value: display, number: moneyToNumber(display) });
  }

  function addTextSignal(target, seen, key, value) {
    const display = cleanText(String(value));
    if (!display || display.length > 90 || /^https?:/i.test(display)) return;
    const id = `${key}:${display}`;
    if (seen.has(id)) return;
    seen.add(id);
    target.push({ label: key, value: display });
  }

  function chooseHiddenRange(signals, displayedPrice, searchRange) {
    const rangeSignals = signals.filter((signal) => /range|guide|marketing|search|price/i.test(signal.label));
    const candidates = rangeSignals
      .map((signal) => signal.value)
      .filter((value) => /\d/.test(value))
      .filter((value) => value !== displayedPrice)
      .map(normalizeMoneyText);

    const exactRange = candidates.find((value) => /\$[\d,]+\s*(?:-|to)\s*\$?[\d,]+/i.test(value));
    if (exactRange) return exactRange;

    const numbers = rangeSignals.map((signal) => signal.number).filter((value) => value >= 50000 && value <= 100000000);
    const unique = [...new Set(numbers)].sort((a, b) => a - b);
    if (unique.length >= 2) {
      return formatRange(unique[0], unique[unique.length - 1]);
    }

    return normalizeMoneyText(searchRange);
  }

  function chooseRent(signals) {
    const rent = signals.find((signal) => /rent/i.test(signal.label) && signal.number >= 50 && signal.number <= 10000);
    return rent ? normalizeMoneyText(rent.value) : "";
  }

  function chooseEstimate(signals, hiddenRange) {
    const estimate = signals.find(
      (signal) => /estimate|valuation|median/i.test(signal.label) && signal.number >= 50000 && signal.number <= 100000000
    );
    return estimate ? normalizeMoneyText(estimate.value) : hiddenRange || "";
  }

  function chooseTextSignal(signals, pattern) {
    const found = signals.find((signal) => pattern.test(signal.label));
    return found?.value || "";
  }

  async function saveSnapshot(listing) {
    const store = await storageGet(STORE_KEY, {});
    const existing = store[listing.id] || { firstSeenAt: listing.seenAt, snapshots: [], note: "" };
    const previous = existing.snapshots[existing.snapshots.length - 1];
    const snapshot = {
      seenAt: listing.seenAt,
      displayedPrice: listing.displayedPrice,
      hiddenRange: listing.hiddenRange,
      searchRange: listing.searchRange,
      status: listing.status,
      agent: listing.agent,
      agency: listing.agency,
      url: listing.url
    };

    const changed =
      !previous ||
      previous.displayedPrice !== snapshot.displayedPrice ||
      previous.hiddenRange !== snapshot.hiddenRange ||
      previous.status !== snapshot.status ||
      previous.agent !== snapshot.agent;

    const snapshots = changed
      ? [...existing.snapshots, snapshot].slice(-MAX_STORED_SNAPSHOTS)
      : existing.snapshots.map((item, index) => index === existing.snapshots.length - 1 ? snapshot : item);

    store[listing.id] = {
      ...existing,
      firstSeenAt: existing.firstSeenAt || listing.seenAt,
      latest: listing,
      snapshots
    };

    await storageSet({ [STORE_KEY]: store });
    return store[listing.id];
  }

  function injectPanel(listing, history) {
    document.querySelector(`#${ROOT_ID}`)?.remove();

    const root = document.createElement("section");
    root.id = ROOT_ID;
    root.innerHTML = renderPanel(listing, history);

    const anchor = findPanelAnchor(listing);
    if (anchor?.parentElement) {
      anchor.parentElement.insertBefore(root, anchor.nextSibling);
    } else {
      document.body.prepend(root);
    }

    wirePanel(root, listing.id);
  }

  function findPanelAnchor(listing) {
    const priceElement = findVisibleElement((text) => text === listing.displayedPrice || /^price guide\b/i.test(text));
    if (priceElement) return priceElement.closest("section, article, div") || priceElement;

    const propertyIdElement = findVisibleElement((text) => /\bProperty ID:\s*\d{5,}\b/i.test(text));
    if (propertyIdElement) return propertyIdElement.closest("section, article, div") || propertyIdElement;

    const heading = querySelectorSafe("h1");
    if (heading) return heading.closest("section, article, div") || heading;

    return (
      querySelectorSafe("[data-testid*='listing']") ||
      querySelectorSafe("main") ||
      document.body.firstElementChild
    );
  }

  function renderPanel(listing, history) {
    const days = daysBetween(history.firstSeenAt, listing.seenAt);
    const changes = countMeaningfulChanges(history.snapshots);
    const yieldText = calculateYield(listing);
    const note = escapeHtml(history.note || "");

    return `
      <div class="hl-panel">
        <div class="hl-header">
          <div class="hl-brand">
            <div class="hl-mark">HL</div>
            <div>
              <h2 class="hl-title">House Lens</h2>
              <p class="hl-subtitle">${escapeHtml(listing.address || listing.title || "Property insight")}</p>
            </div>
          </div>
          <span class="hl-chip">${escapeHtml(listing.portal)}</span>
        </div>
        <div class="hl-tabs" role="tablist">
          <button class="hl-tab" data-tab="overview" aria-selected="true">Overview</button>
          <button class="hl-tab" data-tab="timeline" aria-selected="false">Timeline</button>
          <button class="hl-tab" data-tab="notes" aria-selected="false">Notes</button>
        </div>
        <div class="hl-view" data-view="overview" data-active="true">
          <div class="hl-grid">
            ${metric("Displayed price", listing.displayedPrice || "Not shown", "What the portal currently shows.")}
            ${metric("Detected guide", listing.hiddenRange || listing.searchRange || "No guide found", "Extracted from page data, search filters, or visible content.")}
            ${metric("Seen locally", days === 0 ? "Today" : `${days} day${days === 1 ? "" : "s"}`, "Based on your browser history for this listing.")}
            ${metric("Campaign changes", `${changes}`, "Price, guide, status, or agent changes seen by this browser.")}
            ${metric("Agent", listing.agent || "Not detected", listing.agency || "Agency not detected.")}
            ${metric("Rent / yield", yieldText || listing.rent || "Not detected", "Yield is estimated when both sale guide and rent are available.")}
          </div>
        </div>
        <div class="hl-view" data-view="timeline">
          ${renderTimeline(history.snapshots)}
        </div>
        <div class="hl-view" data-view="notes">
          <div class="hl-note-box">
            <textarea data-note placeholder="Inspection notes, auction result, agent comments, strata details...">${note}</textarea>
            <button class="hl-save" data-save-note>Save note</button>
            <p class="hl-help" data-note-status></p>
          </div>
        </div>
      </div>
    `;
  }

  function metric(label, value, help) {
    return `
      <div class="hl-metric">
        <p class="hl-label">${escapeHtml(label)}</p>
        <p class="hl-value">${escapeHtml(value)}</p>
        <p class="hl-help">${escapeHtml(help)}</p>
      </div>
    `;
  }

  function renderTimeline(snapshots) {
    if (!snapshots?.length) return `<p class="hl-empty">No local history yet.</p>`;
    const items = [...snapshots].reverse().map((snapshot) => {
      const bits = [
        snapshot.displayedPrice && `displayed ${snapshot.displayedPrice}`,
        snapshot.hiddenRange && `guide ${snapshot.hiddenRange}`,
        snapshot.status && snapshot.status,
        snapshot.agent && `agent ${snapshot.agent}`
      ].filter(Boolean);

      return `
        <li>
          <div class="hl-time">${escapeHtml(formatDate(snapshot.seenAt))}</div>
          <div>${escapeHtml(bits.join(" | ") || "Listing observed")}</div>
        </li>
      `;
    }).join("");

    return `<ul class="hl-timeline">${items}</ul>`;
  }

  function wirePanel(root, listingId) {
    root.querySelectorAll(".hl-tab").forEach((tab) => {
      tab.addEventListener("click", () => {
        root.querySelectorAll(".hl-tab").forEach((item) => item.setAttribute("aria-selected", String(item === tab)));
        root.querySelectorAll(".hl-view").forEach((view) => {
          view.dataset.active = String(view.dataset.view === tab.dataset.tab);
        });
      });
    });

    root.querySelector("[data-save-note]")?.addEventListener("click", async () => {
      const textarea = root.querySelector("[data-note]");
      const status = root.querySelector("[data-note-status]");
      const store = await storageGet(STORE_KEY, {});
      if (!store[listingId]) return;
      store[listingId].note = textarea.value;
      await storageSet({ [STORE_KEY]: store });
      status.textContent = "Saved locally.";
      setTimeout(() => {
        status.textContent = "";
      }, 2500);
    });
  }

  function annotateSearchCards() {
    if (!/\/sale|\/buy|\/rent|\/sold|search/i.test(location.pathname)) return;

    const cards = querySelectorAllSafe("article, [data-testid*='listing-card'], [class*='listing' i]")
      .filter((card) => card.querySelector("a[href]"))
      .slice(0, 40);

    cards.forEach((card) => {
      if (card.querySelector(".hl-badge")) return;
      const price = cleanText(card.textContent).match(/\$[\d,.]+(?:\s*(?:-|to)\s*\$?[\d,.]+)?|contact agent|auction/i)?.[0];
      if (!price) return;
      const badge = document.createElement("div");
      badge.className = "hl-badge";
      badge.textContent = `House Lens: ${price}`;
      const target = card.querySelector("a[href]") || card.firstElementChild;
      target?.parentElement?.insertBefore(badge, target.nextSibling);
    });
  }

  function looksLikePriceText(text) {
    if (!text || text.length > 140) return false;
    return /\$[\d,.]+|contact agent|price on request|auction|expressions of interest|offers/i.test(text);
  }

  function isPropertyListingPath() {
    return /^\/property-[a-z0-9+%-]+-\d{5,}\/?$/i.test(location.pathname);
  }

  function findVisibleElement(predicate) {
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    let count = 0;
    while (walker.nextNode() && count < 3500) {
      count += 1;
      const text = cleanText(walker.currentNode.nodeValue);
      if (!text || text.length > 180) continue;
      const parent = walker.currentNode.parentElement;
      if (!parent || parent.offsetParent === null) continue;
      if (predicate(text)) return parent;
    }
    return null;
  }

  function cleanText(value) {
    return String(value || "").replace(/\s+/g, " ").trim();
  }

  function normalizeMoneyText(value) {
    const text = cleanText(value);
    if (!text) return "";
    const range = text.match(/\$?([\d,.]+)\s*(?:-|to)\s*\$?([\d,.]+)/i);
    if (range) return formatRange(moneyToNumber(range[1]), moneyToNumber(range[2]));
    const number = moneyToNumber(text);
    return number ? formatMoney(number) : text;
  }

  function moneyToNumber(value) {
    if (typeof value === "number") return value;
    const text = String(value || "").toLowerCase().replace(/,/g, "");
    const match = text.match(/(\d+(?:\.\d+)?)\s*([mk])?/);
    if (!match) return 0;
    const number = Number(match[1]);
    if (!Number.isFinite(number)) return 0;
    if (match[2] === "m") return Math.round(number * 1000000);
    if (match[2] === "k") return Math.round(number * 1000);
    return Math.round(number);
  }

  function formatRange(min, max) {
    const from = moneyToNumber(min);
    const to = moneyToNumber(max);
    if (from && to) return `${formatMoney(from)} - ${formatMoney(to)}`;
    if (from) return `From ${formatMoney(from)}`;
    if (to) return `Up to ${formatMoney(to)}`;
    return "";
  }

  function formatMoney(value) {
    const number = moneyToNumber(value);
    if (!number) return "";
    return new Intl.NumberFormat("en-AU", {
      style: "currency",
      currency: "AUD",
      maximumFractionDigits: 0
    }).format(number);
  }

  function calculateYield(listing) {
    const rent = moneyToNumber(listing.rent);
    const sale = averageRange(listing.hiddenRange || listing.estimate);
    if (!rent || !sale) return "";
    const annualRent = rent < 50000 ? rent * 52 : rent;
    const grossYield = (annualRent / sale) * 100;
    if (!Number.isFinite(grossYield) || grossYield <= 0 || grossYield > 30) return "";
    return `${grossYield.toFixed(1)}% gross`;
  }

  function averageRange(value) {
    const numbers = String(value || "").match(/\$?[\d,.]+/g)?.map(moneyToNumber).filter(Boolean) || [];
    if (!numbers.length) return 0;
    return Math.round(numbers.reduce((sum, item) => sum + item, 0) / numbers.length);
  }

  function countMeaningfulChanges(snapshots) {
    if (!snapshots?.length) return 0;
    let count = 0;
    for (let index = 1; index < snapshots.length; index += 1) {
      const previous = snapshots[index - 1];
      const current = snapshots[index];
      if (
        previous.displayedPrice !== current.displayedPrice ||
        previous.hiddenRange !== current.hiddenRange ||
        previous.status !== current.status ||
        previous.agent !== current.agent
      ) {
        count += 1;
      }
    }
    return count;
  }

  function daysBetween(start, end) {
    const diff = new Date(end).getTime() - new Date(start).getTime();
    return Math.max(0, Math.floor(diff / 86400000));
  }

  function formatDate(value) {
    return new Intl.DateTimeFormat("en-AU", {
      dateStyle: "medium",
      timeStyle: "short"
    }).format(new Date(value));
  }

  function parseJson(value) {
    try {
      return JSON.parse(value);
    } catch {
      return null;
    }
  }

  function querySelectorSafe(selector) {
    try {
      return document.querySelector(selector);
    } catch {
      return null;
    }
  }

  function querySelectorAllSafe(selector) {
    try {
      return [...document.querySelectorAll(selector)];
    } catch {
      return [];
    }
  }

  function storageGet(key, fallback) {
    return new Promise((resolve) => {
      chrome.storage.local.get({ [key]: fallback }, (result) => resolve(result[key]));
    });
  }

  function storageSet(values) {
    return new Promise((resolve) => chrome.storage.local.set(values, resolve));
  }

  function escapeHtml(value) {
    return String(value ?? "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#039;");
  }

  function hashString(value) {
    let hash = 0;
    for (let index = 0; index < value.length; index += 1) {
      hash = (hash << 5) - hash + value.charCodeAt(index);
      hash |= 0;
    }
    return Math.abs(hash).toString(36);
  }

  function debounce(callback, delay) {
    let timeout;
    return (...args) => {
      clearTimeout(timeout);
      timeout = setTimeout(() => callback(...args), delay);
    };
  }
})();
