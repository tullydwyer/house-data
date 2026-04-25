from __future__ import annotations

import json
import os
import sqlite3
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, Field


DATA_DIR = Path(os.getenv("DATA_DIR", "data"))
DB_PATH = DATA_DIR / "house_lens.sqlite3"


class Snapshot(BaseModel):
    id: str = Field(min_length=1)
    portal: str = ""
    url: str = ""
    listingId: str = ""
    title: str = ""
    address: str = ""
    displayedPrice: str = ""
    hiddenRange: str = ""
    searchRange: str = ""
    status: str = ""
    agent: str = ""
    agency: str = ""
    rent: str = ""
    estimate: str = ""
    seenAt: str = ""
    firstSeenAt: str = ""
    signals: list[dict[str, Any]] = Field(default_factory=list)


app = FastAPI(title="House Lens API", version="0.1.0")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=False,
    allow_methods=["GET", "POST", "OPTIONS"],
    allow_headers=["*"],
)


@app.on_event("startup")
def startup() -> None:
    init_db()


@app.get("/health")
def health() -> dict[str, str]:
    return {"status": "ok"}


@app.post("/snapshots", status_code=201)
def create_snapshot(snapshot: Snapshot) -> dict[str, Any]:
    init_db()
    seen_at = normalize_datetime(snapshot.seenAt)
    payload = snapshot.model_dump()
    payload["seenAt"] = seen_at

    with connect() as db:
        db.execute(
            """
            insert into properties (
                id, portal, listing_id, title, address, first_seen_at, latest_seen_at, latest_payload
            )
            values (?, ?, ?, ?, ?, ?, ?, ?)
            on conflict(id) do update set
                portal = excluded.portal,
                listing_id = excluded.listing_id,
                title = excluded.title,
                address = excluded.address,
                latest_seen_at = excluded.latest_seen_at,
                latest_payload = excluded.latest_payload
            """,
            (
                snapshot.id,
                snapshot.portal,
                snapshot.listingId,
                snapshot.title,
                snapshot.address,
                normalize_datetime(snapshot.firstSeenAt or seen_at),
                seen_at,
                json.dumps(payload, separators=(",", ":")),
            ),
        )
        db.execute(
            """
            insert into snapshots (
                property_id, seen_at, displayed_price, hidden_range, search_range, status, agent, agency, payload
            )
            values (?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                snapshot.id,
                seen_at,
                snapshot.displayedPrice,
                snapshot.hiddenRange,
                snapshot.searchRange,
                snapshot.status,
                snapshot.agent,
                snapshot.agency,
                json.dumps(payload, separators=(",", ":")),
            ),
        )
        db.commit()

    return {"ok": True, "id": snapshot.id, "seenAt": seen_at}


@app.get("/properties")
def list_properties(limit: int = 100) -> dict[str, Any]:
    init_db()
    limit = min(max(limit, 1), 500)
    with connect() as db:
        rows = db.execute(
            """
            select id, portal, listing_id, title, address, first_seen_at, latest_seen_at, latest_payload
            from properties
            order by latest_seen_at desc
            limit ?
            """,
            (limit,),
        ).fetchall()

    return {"items": [row_to_property(row) for row in rows]}


@app.get("/properties/{property_id}")
def get_property(property_id: str) -> dict[str, Any]:
    init_db()
    with connect() as db:
        property_row = db.execute(
            """
            select id, portal, listing_id, title, address, first_seen_at, latest_seen_at, latest_payload
            from properties
            where id = ?
            """,
            (property_id,),
        ).fetchone()
        if not property_row:
            raise HTTPException(status_code=404, detail="Property not found")

        snapshots = db.execute(
            """
            select seen_at, displayed_price, hidden_range, search_range, status, agent, agency, payload
            from snapshots
            where property_id = ?
            order by seen_at desc
            """,
            (property_id,),
        ).fetchall()

    return {
        "property": row_to_property(property_row),
        "snapshots": [row_to_snapshot(row) for row in snapshots],
    }


def init_db() -> None:
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    with connect() as db:
        db.execute(
            """
            create table if not exists properties (
                id text primary key,
                portal text not null default '',
                listing_id text not null default '',
                title text not null default '',
                address text not null default '',
                first_seen_at text not null,
                latest_seen_at text not null,
                latest_payload text not null
            )
            """
        )
        db.execute(
            """
            create table if not exists snapshots (
                id integer primary key autoincrement,
                property_id text not null,
                seen_at text not null,
                displayed_price text not null default '',
                hidden_range text not null default '',
                search_range text not null default '',
                status text not null default '',
                agent text not null default '',
                agency text not null default '',
                payload text not null,
                foreign key(property_id) references properties(id)
            )
            """
        )
        db.execute("create index if not exists idx_snapshots_property_seen on snapshots(property_id, seen_at desc)")
        db.commit()


def connect() -> sqlite3.Connection:
    connection = sqlite3.connect(DB_PATH)
    connection.row_factory = sqlite3.Row
    return connection


def normalize_datetime(value: str) -> str:
    if not value:
        return datetime.now(timezone.utc).isoformat()
    try:
        return datetime.fromisoformat(value.replace("Z", "+00:00")).astimezone(timezone.utc).isoformat()
    except ValueError:
        return datetime.now(timezone.utc).isoformat()


def row_to_property(row: sqlite3.Row) -> dict[str, Any]:
    return {
        "id": row["id"],
        "portal": row["portal"],
        "listingId": row["listing_id"],
        "title": row["title"],
        "address": row["address"],
        "firstSeenAt": row["first_seen_at"],
        "latestSeenAt": row["latest_seen_at"],
        "latest": json.loads(row["latest_payload"]),
    }


def row_to_snapshot(row: sqlite3.Row) -> dict[str, Any]:
    return {
        "seenAt": row["seen_at"],
        "displayedPrice": row["displayed_price"],
        "hiddenRange": row["hidden_range"],
        "searchRange": row["search_range"],
        "status": row["status"],
        "agent": row["agent"],
        "agency": row["agency"],
        "payload": json.loads(row["payload"]),
    }
