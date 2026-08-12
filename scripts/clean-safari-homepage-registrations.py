#!/usr/bin/env python3
"""Safely remove only known stale Safari registrations for this extension."""

from __future__ import annotations

import datetime as dt
import json
import os
import plistlib
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

BUNDLE_ID = "com.aeroluna.homepage.safari.extension"
STALE_KEYS = {
    f"{BUNDLE_ID} (PSTNW3UN4R)",
    f"{BUNDLE_ID} (UNSIGNED)",
}
SAFARI_ROOT = (
    Path.home()
    / "Library"
    / "Containers"
    / "com.apple.Safari"
    / "Data"
    / "Library"
    / "Safari"
)
DEFAULT_FILES = (
    SAFARI_ROOT / "AppExtensions" / "Extensions.plist",
    SAFARI_ROOT / "WebExtensions" / "Extensions.plist",
    SAFARI_ROOT
    / "Profiles"
    / "DefaultProfile"
    / "WebExtensions"
    / "Extensions.plist",
)


def clean_file(path: Path) -> dict[str, object]:
    result: dict[str, object] = {"file": str(path), "removed": [], "backup": None}
    if not path.is_file():
        return result

    with path.open("rb") as stream:
        data = plistlib.load(stream)
    if not isinstance(data, dict):
        raise ValueError(f"Safari registration plist root is not a dictionary: {path}")

    removed = [key for key in data if key in STALE_KEYS]
    if not removed:
        return result

    stamp = dt.datetime.now(dt.UTC).strftime("%Y%m%dT%H%M%SZ")
    backup = path.with_name(f"{path.name}.bak-{stamp}")
    counter = 1
    while backup.exists():
        backup = path.with_name(f"{path.name}.bak-{stamp}-{counter}")
        counter += 1
    shutil.copy2(path, backup)

    for key in removed:
        del data[key]

    descriptor, temp_name = tempfile.mkstemp(prefix=f".{path.name}.", dir=path.parent)
    try:
        with os.fdopen(descriptor, "wb") as stream:
            plistlib.dump(data, stream, fmt=plistlib.FMT_BINARY, sort_keys=False)
        subprocess.run(["/usr/bin/plutil", "-lint", temp_name], check=True, capture_output=True)
        os.replace(temp_name, path)
    except BaseException:
        try:
            os.unlink(temp_name)
        except FileNotFoundError:
            pass
        raise

    result.update(removed=removed, backup=str(backup))
    return result


def safari_is_running() -> bool:
    return subprocess.run(
        ["/usr/bin/pgrep", "-x", "Safari"],
        check=False,
        capture_output=True,
    ).returncode == 0


def main() -> None:
    files = tuple(Path(value).expanduser() for value in sys.argv[1:]) or DEFAULT_FILES
    if not sys.argv[1:] and safari_is_running():
        raise RuntimeError("Safari is running; quit Safari before cleaning extension registrations")
    results = [clean_file(path) for path in files]
    print(json.dumps(results, ensure_ascii=False))


if __name__ == "__main__":
    main()
