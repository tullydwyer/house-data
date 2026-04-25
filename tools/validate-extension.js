const { spawn } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const ROOT = path.resolve(__dirname, "..");
const EXTENSION_PATH = path.join(ROOT, "extension");
const CHROME_PATH = findBrowserPath();

const CASES = [
  {
    name: "Salsa Street listing",
    url:
      process.env.HOUSE_LENS_LISTING_URL ||
      "https://www.realestate.com.au/property-house-qld-ripley-150851492",
    expect: (payload, text) => {
      assert(payload?.type === "listing", "expected listing payload");
      assert(/10 Salsa Street/i.test(payload.listing.address || payload.listing.title || text), "expected Salsa Street address");
      assert(payload.listing.displayedPrice === "Offers Over $875,000", `unexpected displayed price: ${payload.listing.displayedPrice}`);
      assert(!/^sold$/i.test(payload.listing.status || ""), "standalone Sold nav text was captured as listing status");
    }
  },
  {
    name: "QLD 3-bed search",
    url:
      process.env.HOUSE_LENS_SEARCH_URL ||
      "https://www.realestate.com.au/buy/with-3-bedrooms-between-0-1000000-in-qld/list-1?maxBeds=3&source=refinement",
    expect: (payload) => {
      assert(payload?.type === "search", "expected search payload");
      assert(payload.filters?.mode === "buy", "expected buy search mode");
      assert(payload.filters?.location === "qld", `unexpected search location: ${payload.filters?.location}`);
      assert(payload.filters?.maxBeds === 3, `unexpected maxBeds: ${payload.filters?.maxBeds}`);
      assert(payload.filters?.maxPrice === 1000000, `unexpected maxPrice: ${payload.filters?.maxPrice}`);
      assert((payload.results || []).length > 0, "expected at least one scraped search result");
    }
  }
];

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exitCode = 1;
});

async function main() {
  if (!fs.existsSync(CHROME_PATH)) {
    throw new Error(
      `Browser not found at ${CHROME_PATH}. Set CHROME_PATH or BROWSER_PATH to override.`
    );
  }

  const profileDir = fs.mkdtempSync(path.join(os.tmpdir(), "house-lens-chrome-"));
  const port = 9300 + Math.floor(Math.random() * 500);
  const chrome = launchChrome(profileDir, port);

  try {
    const baseUrl = `http://127.0.0.1:${port}`;
    await waitForChrome(baseUrl);
    await waitForExtension(baseUrl, CHROME_PATH, chrome);

    for (const testCase of CASES) {
      const result = await validateCase(baseUrl, testCase);
      console.log(`PASS ${testCase.name}: ${result.summary}`);
    }
  } finally {
    await stopChrome(chrome);
    try {
      fs.rmSync(profileDir, { recursive: true, force: true });
    } catch (error) {
      console.warn(`WARN could not remove temporary Chrome profile: ${error.message}`);
    }
  }
}

function launchChrome(profileDir, port) {
  const args = [
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${profileDir}`,
    `--disable-extensions-except=${EXTENSION_PATH}`,
    `--load-extension=${EXTENSION_PATH}`,
    "--window-size=1440,1200",
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-popup-blocking",
    "about:blank"
  ];

  if (process.env.HOUSE_LENS_HEADED !== "1") {
    args.splice(4, 0, "--headless=new");
  }

  const chrome = spawn(CHROME_PATH, args, {
    stdio: ["ignore", "ignore", "pipe"]
  });

  chrome.stderrText = "";
  chrome.stderr?.setEncoding("utf8");
  chrome.stderr?.on("data", (chunk) => {
    chrome.stderrText = `${chrome.stderrText}${chunk}`.slice(-8000);
  });

  return chrome;
}

function findBrowserPath() {
  const candidates = [
    process.env.CHROME_PATH,
    process.env.BROWSER_PATH,
    "C:\\Program Files\\Google\\Chrome for Testing\\Application\\chrome.exe",
    "C:\\Program Files (x86)\\Google\\Chrome for Testing\\Application\\chrome.exe",
    "C:\\Program Files\\Chromium\\Application\\chrome.exe",
    "C:\\Program Files (x86)\\Chromium\\Application\\chrome.exe",
    "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
    "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
    "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
    "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe"
  ].filter(Boolean);

  return candidates.find((candidate) => fs.existsSync(candidate)) || candidates[0];
}

async function validateCase(baseUrl, testCase) {
  const target = await createTarget(baseUrl);
  const cdp = new CdpClient(target.webSocketDebuggerUrl);
  await cdp.connect();

  try {
    await cdp.send("Page.enable");
    await cdp.send("Runtime.enable");
    await cdp.send("Page.navigate", { url: testCase.url });
    await waitForDocument(cdp, testCase.url);

    let overlay;
    try {
      overlay = await waitForOverlay(cdp, testCase.name);
    } catch (error) {
      const diagnostic = await cdp.evaluate(`(() => ({
        url: location.href,
        title: document.title,
        bodyStart: document.body ? document.body.innerText.slice(0, 1000) : "",
        hasRoot: Boolean(document.querySelector("#house-lens-root")),
        contentScript: document.documentElement.dataset.houseLensContentScript || ""
      }))()`);
      error.message += `\nDiagnostics: ${JSON.stringify(diagnostic, null, 2)}`;
      throw error;
    }
    testCase.expect(overlay.payload, overlay.text);

    return {
      summary:
        overlay.payload.type === "search"
          ? `${overlay.payload.results.length} results, filters ${JSON.stringify(overlay.payload.filters)}`
          : `${overlay.payload.listing.address || overlay.payload.listing.title}, status "${overlay.payload.listing.status || ""}"`
    };
  } finally {
    await cdp.close();
  }
}

async function createTarget(baseUrl) {
  const response = await fetch(`${baseUrl}/json/new?${encodeURIComponent("about:blank")}`, {
    method: "PUT"
  });
  if (!response.ok) throw new Error(`Could not create Chrome target: ${response.status}`);
  return response.json();
}

async function waitForChrome(baseUrl) {
  const started = Date.now();
  while (Date.now() - started < 20000) {
    try {
      const response = await fetch(`${baseUrl}/json/version`);
      if (response.ok) return;
    } catch {
      await sleep(250);
    }
  }
  throw new Error("Timed out waiting for Chrome DevTools endpoint.");
}

async function waitForExtension(baseUrl, browserPath, chrome) {
  const started = Date.now();

  while (Date.now() - started < 15000) {
    try {
      const response = await fetch(`${baseUrl}/json/list`);
      if (response.ok) {
        const targets = await response.json();
        const hasHouseLensWorker = targets.some(
          (target) =>
            typeof target?.url === "string" &&
            /^chrome-extension:\/\/[^/]+\/src\/background\.js$/i.test(target.url)
        );

        if (hasHouseLensWorker) return;
      }
    } catch {
      // Chrome can expose DevTools before the extension worker target appears.
    }

    await sleep(250);
  }

  const warning = extractBrowserWarning(chrome.stderrText || "");
  const hint = warning ? `\nBrowser output: ${warning}` : "";
  throw new Error(
    `House Lens extension did not load in ${browserPath}. Set CHROME_PATH or BROWSER_PATH to Edge, Chromium, or Chrome for Testing.${hint}`
  );
}

function extractBrowserWarning(stderrText) {
  if (!stderrText) return "";

  const lines = stderrText
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);

  return (
    lines.find((line) => /disable-extensions-except|load-extension/i.test(line)) || ""
  );
}

async function waitForDocument(cdp, expectedUrl) {
  await waitUntil(async () => {
    const result = await cdp.evaluate(`({
      readyState: document.readyState,
      href: location.href,
      title: document.title
    })`);
    const isExpectedUrl = result.href === expectedUrl || result.href.startsWith(expectedUrl.split("?")[0]);
    const isReady = result.readyState === "complete" || result.readyState === "interactive";
    return isExpectedUrl && isReady ? result : false;
  }, 60000, "document did not navigate to expected URL");
}

async function waitForOverlay(cdp, name) {
  return waitUntil(async () => {
    const result = await cdp.evaluate(`(() => {
      const root = document.querySelector("#house-lens-root");
      if (!root) return null;
      let payload = null;
      try {
        payload = JSON.parse(root.dataset.houseLensDebug || "null");
      } catch {}
      return {
        text: root.innerText,
        payload,
        pageTitle: document.title,
        bodyStart: document.body.innerText.slice(0, 800)
      };
    })()`);

    if (result?.payload) return result;
    return false;
  }, 90000, `House Lens overlay did not appear for ${name}`);
}

async function waitUntil(callback, timeoutMs, message) {
  const started = Date.now();
  let lastError;

  while (Date.now() - started < timeoutMs) {
    try {
      const value = await callback();
      if (value) return value;
    } catch (error) {
      lastError = error;
    }
    await sleep(500);
  }

  if (lastError) throw lastError;
  throw new Error(message);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function stopChrome(chrome) {
  if (chrome.exitCode !== null) return;

  if (process.platform === "win32") {
    await new Promise((resolve) => {
      const killer = spawn("taskkill", ["/PID", String(chrome.pid), "/T", "/F"], {
        stdio: "ignore"
      });
      killer.on("exit", resolve);
      killer.on("error", resolve);
    });
  } else {
    chrome.kill("SIGTERM");
  }

  await sleep(1000);
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

class CdpClient {
  constructor(wsUrl) {
    this.wsUrl = wsUrl;
    this.nextId = 1;
    this.pending = new Map();
  }

  connect() {
    return new Promise((resolve, reject) => {
      this.ws = new WebSocket(this.wsUrl);
      this.ws.addEventListener("open", resolve, { once: true });
      this.ws.addEventListener("error", reject, { once: true });
      this.ws.addEventListener("message", (event) => this.onMessage(event));
    });
  }

  send(method, params = {}) {
    const id = this.nextId++;
    const message = JSON.stringify({ id, method, params });

    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(message);
    });
  }

  async evaluate(expression) {
    const response = await this.send("Runtime.evaluate", {
      expression,
      awaitPromise: true,
      returnByValue: true
    });

    if (response.exceptionDetails) {
      throw new Error(response.exceptionDetails.text || "Runtime evaluation failed");
    }

    return response.result?.value;
  }

  onMessage(event) {
    const message = JSON.parse(event.data);
    if (!message.id || !this.pending.has(message.id)) return;

    const pending = this.pending.get(message.id);
    this.pending.delete(message.id);

    if (message.error) {
      pending.reject(new Error(message.error.message));
    } else {
      pending.resolve(message.result);
    }
  }

  close() {
    return new Promise((resolve) => {
      if (!this.ws || this.ws.readyState === WebSocket.CLOSED) {
        resolve();
        return;
      }
      this.ws.addEventListener("close", resolve, { once: true });
      this.ws.close();
    });
  }
}
