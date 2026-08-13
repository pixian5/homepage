#!/usr/bin/env python3
"""Configure and verify Safari's selected extension page for new tabs/windows."""

from __future__ import annotations

import argparse
import json
import plistlib
import re
import subprocess
import sys
from pathlib import Path

BUNDLE_ID = "com.aeroluna.homepage.safari.extension"
PROFILE = "DefaultProfile"
PREFERENCE_KEYS = (
    "IdentifierOfExtensionWithOverridePageForNewTabs",
    "IdentifierOfExtensionWithOverridePageForNewWindows",
)


def extension_identity(team_id: str) -> str:
    return f"{BUNDLE_ID} ({team_id})"


def signed_team_id(app_path: Path) -> str:
    appex_path = app_path / "Contents/PlugIns/我的首页 Safari Extension.appex"
    result = subprocess.run(
        ["/usr/bin/codesign", "-dv", "--verbose=4", str(appex_path)],
        check=False,
        capture_output=True,
        text=True,
    )
    match = re.search(r"^TeamIdentifier=(.+)$", result.stderr, re.MULTILINE)
    if result.returncode or not match:
        raise RuntimeError(f"cannot determine Safari extension signing team: {appex_path}")
    return match.group(1).strip()


def read_preferences(defaults_plist: Path | None) -> dict[str, object]:
    if defaults_plist:
        with defaults_plist.open("rb") as stream:
            data = plistlib.load(stream)
    else:
        result = subprocess.run(
            ["/usr/bin/defaults", "export", "com.apple.Safari", "-"],
            check=True,
            capture_output=True,
        )
        data = plistlib.loads(result.stdout)
    if not isinstance(data, dict):
        raise ValueError("Safari preferences root is not a dictionary")
    return data


def selected_preferences(preferences: dict[str, object], identity: str, profile: str) -> dict[str, bool]:
    result: dict[str, bool] = {}
    for key in PREFERENCE_KEYS:
        value = preferences.get(key)
        result[key] = isinstance(value, dict) and value.get(profile) == identity
    return result


def configure(identity: str, profile: str) -> None:
    # `defaults` parses dictionary values as property-list literals. Quote the
    # identity so its team suffix's spaces and parentheses stay one string.
    plist_string = json.dumps(identity)
    for key in PREFERENCE_KEYS:
        subprocess.run(
            ["/usr/bin/defaults", "write", "com.apple.Safari", key, "-dict-add", profile, plist_string],
            check=True,
        )


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("command", choices=("configure", "verify"))
    parser.add_argument("--team-id")
    parser.add_argument("--app-path", type=Path, default=Path("/Applications/我的首页 Safari.app"))
    parser.add_argument("--profile", default=PROFILE)
    parser.add_argument("--defaults-plist", type=Path)
    return parser.parse_args()


def main() -> None:
    args = parse_args()
    if args.defaults_plist and args.command == "configure":
        raise ValueError("--defaults-plist is only supported by verify")
    team_id = args.team_id or signed_team_id(args.app_path)
    identity = extension_identity(team_id)
    if args.command == "configure":
        configure(identity, args.profile)

    preferences = read_preferences(args.defaults_plist)
    selected = selected_preferences(preferences, identity, args.profile)
    payload = {"identity": identity, "profile": args.profile, "selected": selected}
    print(json.dumps(payload, ensure_ascii=False, sort_keys=True))
    if not all(selected.values()):
        missing = [key for key, matches in selected.items() if not matches]
        raise SystemExit(f"Safari homepage extension is not selected for: {', '.join(missing)}")


if __name__ == "__main__":
    try:
        main()
    except (OSError, ValueError, subprocess.CalledProcessError, RuntimeError) as error:
        print(f"[safari-newtab] ERROR: {error}", file=sys.stderr)
        raise SystemExit(1) from error
