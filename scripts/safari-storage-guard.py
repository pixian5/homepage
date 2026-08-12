#!/usr/bin/env python3
"""Back up and guard Safari WebExtension storage across app updates."""

from __future__ import annotations

import argparse
import datetime as dt
import hashlib
import json
import os
import shutil
import sqlite3
import sys
from pathlib import Path

BUNDLE_ID = "com.aeroluna.homepage.safari.extension"
ROOT_KEY = "homepage_data"
WEB_EXTENSIONS_ROOT = Path(
    os.environ.get(
        "SAFARI_WEB_EXTENSIONS_ROOT",
        Path.home()
        / "Library"
        / "Containers"
        / "com.apple.Safari"
        / "Data"
        / "Library"
        / "WebKit"
        / "WebExtensions",
    )
)


def storage_dirs() -> list[Path]:
    matches: list[Path] = []
    for profile in WEB_EXTENSIONS_ROOT.iterdir() if WEB_EXTENSIONS_ROOT.is_dir() else ():
        if not profile.is_dir():
            continue
        matches.extend(
            child
            for child in profile.iterdir()
            if child.is_dir() and child.name.startswith(f"{BUNDLE_ID} (")
        )
    return sorted(matches)


def read_rows(database: Path) -> dict[str, str]:
    if not database.is_file():
        return {}
    connection = sqlite3.connect(f"file:{database}?mode=ro", uri=True)
    try:
        rows = connection.execute("SELECT key, value FROM extension_storage").fetchall()
        return {str(key): str(value) for key, value in rows}
    finally:
        connection.close()


def homepage_metrics(rows: dict[str, str]) -> dict[str, object]:
    raw = rows.get(ROOT_KEY, "")
    try:
        data = json.loads(raw) if raw else None
    except json.JSONDecodeError:
        data = None
    nodes = data.get("nodes") if isinstance(data, dict) else None
    groups = data.get("groups") if isinstance(data, dict) else None
    backups = data.get("backups") if isinstance(data, dict) else None
    return {
        "hasHomepageData": bool(raw),
        "homepageBytes": len(raw.encode()),
        "nodeCount": len(nodes) if isinstance(nodes, dict) else 0,
        "groupCount": len(groups) if isinstance(groups, list) else 0,
        "backupCount": len(backups) if isinstance(backups, list) else 0,
        "homepageSha256": hashlib.sha256(raw.encode()).hexdigest() if raw else "",
    }


def source_candidates() -> list[tuple[Path, dict[str, str], dict[str, object]]]:
    candidates = []
    for directory in storage_dirs():
        rows = read_rows(directory / "LocalStorage.db")
        candidates.append((directory, rows, homepage_metrics(rows)))
    return candidates


def choose_source(candidates: list[tuple[Path, dict[str, str], dict[str, object]]]):
    if not candidates:
        return None
    return max(
        candidates,
        key=lambda candidate: (
            int(candidate[2]["nodeCount"]),
            int(candidate[2]["homepageBytes"]),
            sum(len(value.encode()) for value in candidate[1].values()),
        ),
    )


def snapshot(output_root: Path) -> dict[str, object]:
    stamp = dt.datetime.now(dt.UTC).strftime("%Y%m%dT%H%M%SZ")
    target = output_root / f"safari-update-{stamp}"
    counter = 1
    while target.exists():
        target = output_root / f"safari-update-{stamp}-{counter}"
        counter += 1
    target.mkdir(parents=True)

    candidates = source_candidates()
    selected = choose_source(candidates)
    manifest: dict[str, object] = {
        "createdAt": stamp,
        "bundleId": BUNDLE_ID,
        "selectedSource": str(selected[0]) if selected else None,
        "metrics": selected[2] if selected else homepage_metrics({}),
        "rowsFile": "extension-storage.json" if selected else None,
        "candidates": [
            {"directory": str(directory), "metrics": metrics}
            for directory, _rows, metrics in candidates
        ],
    }
    if selected:
        directory, rows, _metrics = selected
        (target / "extension-storage.json").write_text(
            json.dumps(rows, ensure_ascii=False), encoding="utf-8"
        )
        raw_dir = target / "raw"
        raw_dir.mkdir()
        for name in ("LocalStorage.db", "LocalStorage.db-wal", "LocalStorage.db-shm", "State.plist"):
            source = directory / name
            if source.is_file():
                shutil.copy2(source, raw_dir / name)
    (target / "manifest.json").write_text(
        json.dumps(manifest, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
    )
    return {"snapshot": str(target), **manifest}


def target_directory() -> Path:
    current = WEB_EXTENSIONS_ROOT / "Default" / f"{BUNDLE_ID} (WY97WQFBKC)"
    current.mkdir(parents=True, exist_ok=True)
    return current


def restore_rows(rows: dict[str, str], directory: Path) -> None:
    database = directory / "LocalStorage.db"
    connection = sqlite3.connect(database)
    try:
        connection.execute(
            "CREATE TABLE IF NOT EXISTS extension_storage "
            "(key TEXT PRIMARY KEY NOT NULL, value TEXT NOT NULL)"
        )
        connection.executemany(
            "INSERT OR REPLACE INTO extension_storage(key, value) VALUES (?, ?)", rows.items()
        )
        connection.commit()
        connection.execute("PRAGMA wal_checkpoint(TRUNCATE)").fetchall()
    finally:
        connection.close()


def verify(snapshot_dir: Path, restore_on_regression: bool) -> dict[str, object]:
    manifest = json.loads((snapshot_dir / "manifest.json").read_text(encoding="utf-8"))
    expected = manifest["metrics"]
    rows_path = snapshot_dir / "extension-storage.json"
    expected_rows = json.loads(rows_path.read_text(encoding="utf-8")) if rows_path.is_file() else {}
    directory = target_directory()
    actual_rows = read_rows(directory / "LocalStorage.db")
    actual = homepage_metrics(actual_rows)
    # Safari 已在快照前退出，安装期间不存在合法用户写入；任何 payload 哈希变化
    # 都代表更新过程改写了数据。节点数/字节数无法发现设置或备份被默认值替换。
    regression = bool(expected["hasHomepageData"]) and (
        not bool(actual["hasHomepageData"])
        or actual["homepageSha256"] != expected["homepageSha256"]
    )
    restored = False
    if regression and restore_on_regression:
        restore_rows(expected_rows, directory)
        actual = homepage_metrics(read_rows(directory / "LocalStorage.db"))
        restored = True
    result = {
        "snapshot": str(snapshot_dir),
        "expected": expected,
        "actual": actual,
        "regression": regression,
        "restored": restored,
    }
    if regression:
        print(json.dumps(result, ensure_ascii=False))
        action = "backup was restored" if restored else "backup is available"
        raise RuntimeError(f"Safari homepage storage regressed during update; {action}")
    return result


def main() -> None:
    parser = argparse.ArgumentParser()
    subparsers = parser.add_subparsers(dest="command", required=True)
    snapshot_parser = subparsers.add_parser("snapshot")
    snapshot_parser.add_argument("--output-root", type=Path, required=True)
    verify_parser = subparsers.add_parser("verify")
    verify_parser.add_argument("--snapshot", type=Path, required=True)
    verify_parser.add_argument("--restore-on-regression", action="store_true")
    args = parser.parse_args()

    if args.command == "snapshot":
        result = snapshot(args.output_root)
    else:
        result = verify(args.snapshot, args.restore_on_regression)
    print(json.dumps(result, ensure_ascii=False))


if __name__ == "__main__":
    try:
        main()
    except Exception as error:
        print(f"[safari-storage] {error}", file=sys.stderr)
        raise
