#!/usr/bin/env python3
"""检查已安装的 Safari 宿主 App 的签名与描述文件状态。

只做只读检查，不修改任何文件、不动 Safari。用于判断是否需要续签：
免费 Apple ID（Apple 账户）由 Xcode（苹果开发工具）自动管理的开发描述文件
有效期只有 7 天，到期后扩展会静默失效，表现为装了却加载不出来。

用法：
    python3 scripts/safari-signing-status.py                 # 人类可读输出
    python3 scripts/safari-signing-status.py --json          # JSON 输出
    python3 scripts/safari-signing-status.py --app-path X    # 指定检查目标（测试用）

退出码：
    0  状态正常，暂不需要续签
    1  需要续签（剩余天数不足或签名/权限缺失）
    2  目标不存在或解析失败
"""

from __future__ import annotations

import argparse
import json
import plistlib
import re
import subprocess
import sys
from datetime import datetime, timezone
from pathlib import Path

DEFAULT_APP_NAME = "我的首页 Safari"
DEFAULT_APP_PATH = Path(f"/Applications/{DEFAULT_APP_NAME}.app")
DEFAULT_APP_GROUP = "group.com.aeroluna.homepage.safari"
# 剩余不足这个天数就建议续签；留足缓冲，避免某天没开机就错过窗口
REFRESH_THRESHOLD_DAYS = 3


def run(*args: str) -> str:
    """执行命令并返回标准输出，失败时返回空字符串。"""
    try:
        result = subprocess.run(args, capture_output=True, text=True, check=False)
    except OSError:
        return ""
    return result.stdout or ""


def read_signature(app_path: Path) -> dict[str, object]:
    """读取代码签名身份、团队标识与是否 adhoc（无证书签名）。"""
    detail = run("/usr/bin/codesign", "-dv", "--verbose=4", str(app_path))
    # codesign -dv 的详细输出走标准错误，需要合并
    if not detail:
        proc = subprocess.run(
            ["/usr/bin/codesign", "-dv", "--verbose=4", str(app_path)],
            capture_output=True,
            text=True,
            check=False,
        )
        detail = f"{proc.stdout}\n{proc.stderr}"

    team = ""
    match = re.search(r"^TeamIdentifier=(.+)$", detail, re.MULTILINE)
    if match:
        team = match.group(1).strip()

    authority = ""
    for line in detail.splitlines():
        if line.strip().startswith("Authority=Apple Development"):
            authority = line.split("=", 1)[1].strip()
            break

    # codesign --verify 的结果同样写在标准错误里，只读标准输出会永远判断为失败
    verify = subprocess.run(
        ["/usr/bin/codesign", "--verify", "--deep", "--strict", "--verbose=2", str(app_path)],
        capture_output=True,
        text=True,
        check=False,
    )
    verify_output = f"{verify.stdout}\n{verify.stderr}"

    return {
        "team_id": "" if team == "not set" else team,
        "identity": authority,
        "adhoc": "Signature=adhoc" in detail,
        "verified": verify.returncode == 0 and "valid on disk" in verify_output,
    }


def read_embedded_profile(app_path: Path) -> dict[str, object]:
    """解析内嵌的 provisioning profile（描述文件），返回剩余天数等关键字段。"""
    profile_path = app_path / "Contents" / "embedded.provisionprofile"
    if not profile_path.is_file():
        return {"present": False}

    decoded = subprocess.run(
        ["/usr/bin/security", "cms", "-D", "-i", str(profile_path)],
        capture_output=True,
        check=False,
    )
    if decoded.returncode != 0 or not decoded.stdout:
        return {"present": True, "parse_error": True}

    try:
        profile = plistlib.loads(decoded.stdout)
    except Exception:  # noqa: BLE001 - 解析失败时只报告状态，不中断整个检查
        return {"present": True, "parse_error": True}

    expiration = profile.get("ExpirationDate")
    days_left = None
    if isinstance(expiration, datetime):
        now = datetime.now(timezone.utc).replace(tzinfo=None)
        days_left = round((expiration - now).total_seconds() / 86400, 2)

    return {
        "present": True,
        "uuid": profile.get("UUID", ""),
        "name": profile.get("Name", ""),
        "expiration": expiration.isoformat() + "Z" if isinstance(expiration, datetime) else "",
        "days_remaining": days_left,
        "xcode_managed": bool(profile.get("IsXcodeManaged", False)),
        "time_to_live": profile.get("TimeToLive"),
        "team_name": profile.get("TeamName", ""),
    }


def has_app_group(target: Path, group: str) -> bool:
    """判断目标签名里是否带指定的 App Group（应用组）权限。"""
    proc = subprocess.run(
        ["/usr/bin/codesign", "-d", "--entitlements", ":-", str(target)],
        capture_output=True,
        text=True,
        check=False,
    )
    return group in (proc.stdout or "")


def safari_running() -> bool:
    proc = subprocess.run(["/usr/bin/pgrep", "-x", "Safari"], capture_output=True, check=False)
    return proc.returncode == 0


def collect(
    app_path: Path, app_name: str, group: str, threshold: float = REFRESH_THRESHOLD_DAYS
) -> dict[str, object]:
    if not app_path.exists():
        return {"installed": False, "app_path": str(app_path)}

    appex = app_path / "Contents" / "PlugIns" / f"{app_name} Extension.appex"
    signature = read_signature(app_path)
    profile = read_embedded_profile(app_path)

    days_left = profile.get("days_remaining")
    signature_verified = bool(signature.get("verified"))
    # 去掉内嵌描述文件是有意的做法：bundle 不需要 profile，也没有 7 天过期。
    # 只有签名本身失效才需要重建。
    profile_free = (
        not profile.get("present") and signature_verified and not signature.get("adhoc")
    )
    needs_refresh = (
        profile.get("parse_error", False)
        or (days_left is not None and days_left < threshold)
        or (not profile.get("present") and not profile_free)
    )

    return {
        "installed": True,
        "app_path": str(app_path),
        "version": run("/usr/bin/defaults", "read", str(app_path / "Contents" / "Info.plist"),
                       "CFBundleShortVersionString").strip(),
        "bundle_id": run("/usr/bin/defaults", "read", str(app_path / "Contents" / "Info.plist"),
                         "CFBundleIdentifier").strip(),
        **signature,
        "profile": profile,
        "app_group": {
            "app": has_app_group(app_path, group),
            "appex": has_app_group(appex, group) if appex.exists() else False,
        },
        "safari_running": safari_running(),
        "profile_free": profile_free,
        "needs_refresh": needs_refresh,
        "refresh_threshold_days": threshold,
    }


def render(status: dict[str, object]) -> str:
    lines = []
    if not status.get("installed"):
        return f"未安装：{status['app_path']}"

    lines.append(f"安装位置 : {status['app_path']}")
    lines.append(f"版本     : {status.get('version') or '未知'}")
    lines.append(f"签名身份 : {status.get('identity') or '（无）'}")
    lines.append(f"团队标识 : {status.get('team_id') or '（无，adhoc 签名不可用）'}")
    lines.append(f"adhoc    : {'是（扩展无法运行）' if status.get('adhoc') else '否'}")
    lines.append(f"深度校验 : {'通过' if status.get('verified') else '失败'}")

    profile = status.get("profile") or {}
    if not profile.get("present"):
        lines.append("描述文件 : 无（已去除，不受 7 天过期约束）")
    elif profile.get("parse_error"):
        lines.append("描述文件 : 解析失败")
    else:
        lines.append(f"描述文件 : {profile.get('name') or '（无名）'}")
        lines.append(f"到期时间 : {profile.get('expiration')}（剩余 {profile.get('days_remaining')} 天）")
        lines.append(f"Xcode 托管: {'是' if profile.get('xcode_managed') else '否'}")

    group = status.get("app_group") or {}
    lines.append(f"应用组   : 宿主 {'有' if group.get('app') else '缺'} / 扩展 {'有' if group.get('appex') else '缺'}")
    lines.append(f"Safari   : {'运行中（续签需先退出）' if status.get('safari_running') else '未运行'}")

    if status.get("needs_refresh"):
        lines.append("")
        lines.append(f"结论     : 需要续签（阈值 {status.get('refresh_threshold_days')} 天）——"
                     "执行 bash scripts/safari-refresh-signing.sh")
    elif status.get("profile_free"):
        lines.append("")
        lines.append("结论     : 无描述文件，不受 7 天过期约束；"
                     "签名证书到期前（免费账号 1 年）无需续签")
    else:
        lines.append("")
        lines.append("结论     : 状态正常，暂不需要续签")
    return "\n".join(lines)


def main() -> int:
    parser = argparse.ArgumentParser(description="检查 Safari 扩展签名与描述文件状态")
    parser.add_argument("--app-path", type=Path, default=DEFAULT_APP_PATH, help="待检查的 .app 路径")
    parser.add_argument("--app-name", default=DEFAULT_APP_NAME, help="宿主 App 名称")
    parser.add_argument("--app-group", default=DEFAULT_APP_GROUP, help="稳定存储的 App Group 标识")
    parser.add_argument(
        "--threshold",
        type=float,
        default=REFRESH_THRESHOLD_DAYS,
        help=f"剩余不足多少天判定为需要续签（默认 {REFRESH_THRESHOLD_DAYS}）",
    )
    parser.add_argument("--json", action="store_true", help="以 JSON 输出")
    args = parser.parse_args()

    status = collect(args.app_path, args.app_name, args.app_group, args.threshold)
    if args.json:
        print(json.dumps(status, ensure_ascii=False, indent=2))
    else:
        print(render(status))

    if not status.get("installed"):
        return 2
    return 1 if status.get("needs_refresh") else 0


if __name__ == "__main__":
    sys.exit(main())
