chrome.runtime.onInstalled.addListener(() => {
  chrome.storage.sync.get(
    {
      apiEnabled: false,
      apiBaseUrl: "http://localhost:8787",
      overlayEnabled: true
    },
    (settings) => chrome.storage.sync.set(settings)
  );
});

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type !== "HOUSE_LENS_SYNC_SNAPSHOT") {
    return false;
  }

  chrome.storage.sync.get({ apiEnabled: false, apiBaseUrl: "http://localhost:8787" }, async (settings) => {
    if (!settings.apiEnabled) {
      sendResponse({ ok: true, skipped: true });
      return;
    }

    try {
      const response = await fetch(`${settings.apiBaseUrl.replace(/\/$/, "")}/snapshots`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(message.payload)
      });

      sendResponse({ ok: response.ok, status: response.status });
    } catch (error) {
      sendResponse({ ok: false, error: error.message });
    }
  });

  return true;
});
