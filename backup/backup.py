"""Daily logical backups of a GraphDB repository in compressed TriG."""

from __future__ import annotations

import base64
import gzip
import os
import shutil
import signal
import threading
from datetime import UTC, datetime, timedelta
from pathlib import Path
from urllib.parse import quote
from urllib.request import Request, urlopen


GRAPHDB_URL = os.getenv("GRAPHDB_URL", "http://graphdb:7200").rstrip("/")
REPOSITORY = os.getenv("GRAPHDB_REPOSITORY", "orca-graph")
BACKUP_DIR = Path(os.getenv("BACKUP_DIR", "/backups"))
INTERVAL_SECONDS = max(60, int(os.getenv("BACKUP_INTERVAL_SECONDS", "86400")))
RETENTION_DAYS = max(1, int(os.getenv("BACKUP_RETENTION_DAYS", "30")))
GRAPHDB_USERNAME = os.getenv("GRAPHDB_USERNAME")
GRAPHDB_PASSWORD = os.getenv("GRAPHDB_PASSWORD")
STOP_EVENT = threading.Event()


def export_url() -> str:
    repository = quote(REPOSITORY, safe="")
    return f"{GRAPHDB_URL}/repositories/{repository}/statements"


def request_headers() -> dict[str, str]:
    headers = {
        "Accept": "application/trig",
        "User-Agent": "ORCA-Graph-Backup/1.0",
    }
    if GRAPHDB_USERNAME and GRAPHDB_PASSWORD:
        credentials = base64.b64encode(
            f"{GRAPHDB_USERNAME}:{GRAPHDB_PASSWORD}".encode()
        ).decode()
        headers["Authorization"] = f"Basic {credentials}"
    return headers


def create_backup(now: datetime | None = None) -> Path:
    now = now or datetime.now(UTC)
    BACKUP_DIR.mkdir(parents=True, exist_ok=True)
    filename = f"orca-graph_{now:%Y%m%dT%H%M%SZ}.trig.gz"
    destination = BACKUP_DIR / filename
    temporary = BACKUP_DIR / f".{filename}.tmp"
    request = Request(export_url(), headers=request_headers())
    try:
        with urlopen(request, timeout=3600) as response:
            with gzip.open(temporary, "wb", compresslevel=6) as output:
                shutil.copyfileobj(response, output, length=1024 * 1024)
        if temporary.stat().st_size == 0:
            raise RuntimeError("GraphDB returned an empty backup")
        temporary.replace(destination)
        return destination
    except Exception:
        temporary.unlink(missing_ok=True)
        raise


def prune_backups(now: datetime | None = None) -> int:
    now = now or datetime.now(UTC)
    cutoff = now - timedelta(days=RETENTION_DAYS)
    removed = 0
    for backup in BACKUP_DIR.glob("orca-graph_*.trig.gz"):
        modified = datetime.fromtimestamp(backup.stat().st_mtime, UTC)
        if modified < cutoff:
            backup.unlink()
            removed += 1
    return removed


def stop(_signum: int, _frame: object) -> None:
    STOP_EVENT.set()


def main() -> None:
    signal.signal(signal.SIGTERM, stop)
    signal.signal(signal.SIGINT, stop)
    print(
        f"Daily TriG backup enabled for {REPOSITORY}; "
        f"retention={RETENTION_DAYS} days"
    )
    while not STOP_EVENT.is_set():
        try:
            backup = create_backup()
            removed = prune_backups()
            print(f"Backup completed: {backup.name}; expired removed={removed}")
        except Exception as error:
            print(f"Backup failed: {error}", flush=True)
        STOP_EVENT.wait(INTERVAL_SECONDS)


if __name__ == "__main__":
    main()
