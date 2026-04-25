const overlayEnabled = document.querySelector("#overlayEnabled");
const apiEnabled = document.querySelector("#apiEnabled");
const apiBaseUrl = document.querySelector("#apiBaseUrl");
const saveButton = document.querySelector("#save");
const status = document.querySelector("#status");

chrome.storage.sync.get(
  {
    overlayEnabled: true,
    apiEnabled: false,
    apiBaseUrl: "http://localhost:8787"
  },
  (settings) => {
    overlayEnabled.checked = settings.overlayEnabled;
    apiEnabled.checked = settings.apiEnabled;
    apiBaseUrl.value = settings.apiBaseUrl;
  }
);

saveButton.addEventListener("click", () => {
  chrome.storage.sync.set(
    {
      overlayEnabled: overlayEnabled.checked,
      apiEnabled: apiEnabled.checked,
      apiBaseUrl: apiBaseUrl.value.trim() || "http://localhost:8787"
    },
    () => {
      status.textContent = "Saved. Refresh the listing page to re-run extraction.";
      setTimeout(() => {
        status.textContent = "";
      }, 3000);
    }
  );
});
