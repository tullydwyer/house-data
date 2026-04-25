# House Lens

House Lens is a Chrome extension. It adds buyer-focused property insights directly to Australian listing pages on Domain, realestate.com.au, and Allhomes.

The extension runs without hosted infrastructure. It stores campaign history and notes locally in Chrome. If you want shared or long-lived storage later, the included Dockerized API accepts snapshots and stores them in SQLite.

## Features

- On-page insight panel for property listing pages.
- Search-result scraping on supported portal list pages, with parsed filters, a summary table, and per-card badges.
- Visible price, detected guide/range, search range, status, agent, agency, rent, and estimated gross yield where available.
- Local campaign timeline that records changes seen by your browser.
- Local notes per listing for inspection notes, auction results, strata details, or agent comments.
- Search-result badges for quick price scanning.
- Optional API sync to a self-hosted FastAPI service.

## Load the Extension

1. Open Chrome and go to `chrome://extensions`.
2. Enable `Developer mode`.
3. Click `Load unpacked`.
4. Select the `extension` folder in this repo.
5. Visit a listing page on Domain, realestate.com.au, or Allhomes.

Open the House Lens popup to enable or disable the overlay and configure API sync.

## Optional API

Start the snapshot API:

```powershell
docker compose up --build
```

The API listens on `http://localhost:8787`.

Useful endpoints:

- `GET /health`
- `POST /snapshots`
- `GET /properties`
- `GET /properties/{property_id}`

In the extension popup, turn on `Sync snapshots to API` and keep the API base URL as `http://localhost:8787`.

## Project Layout

```text
extension/
  manifest.json
  popup.html
  src/
    background.js
    content.css
    content.js
    popup.css
    popup.js
backend/
  app/main.py
  Dockerfile
  requirements.txt
docker-compose.yml
```

## Notes

Property portals change their page structure often. The extractor deliberately uses multiple signals: visible text, JSON-LD, embedded app state, URL filters, and local history.
