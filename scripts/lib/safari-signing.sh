#!/usr/bin/env bash
# Safari 宿主 App 与扩展的公共签名函数库。
# 由 scripts/build-macos.command 与 scripts/safari-refresh-signing.sh 共同 source，
# 避免完整构建路径与快速续签路径各自维护一份 codesign 逻辑。
#
# source 前调用方必须已定义：
#   SAFARI_APP_NAME  宿主 App 名称，例如 "我的首页 Safari"
#   SAFARI_BUILD_DIR xcodebuild 的 -derivedDataPath
# 可选：
#   SAFARI_APP_GROUP_ID 稳定存储的应用组标识

# 从钥匙串取第一个可用的 Apple Development（苹果开发）签名身份。
# 免费 Apple ID（Apple 账户）与付费会员都用这一类身份，取不到就说明 Xcode 没登录。
detect_apple_development_identity() {
  security find-identity -p codesigning -v 2>/dev/null \
    | sed -n 's/.*"\(Apple Development: .* ([A-Z0-9]\{10\})\)".*/\1/p' \
    | head -n 1
}

# 清除本项目在 Xcode（苹果开发工具）里的开发描述文件缓存。
#
# 关键实测结论：只要本地缓存里还留着一份**未过期**的 profile（描述文件），
# xcodebuild -allowProvisioningUpdates 就会直接复用它，不会申请新的，
# 续签后剩余天数纹丝不动。必须先删掉本项目的缓存，Xcode 才会重新签发一整份新的 7 天 profile。
# 只删与本项目 Bundle ID 匹配的条目，不碰其他项目的描述文件。
purge_safari_profile_cache() {
  local bundle_id="${SAFARI_BUNDLE_ID:-com.aeroluna.homepage.safari}"
  local cache_dir="${HOME}/Library/Developer/Xcode/UserData/Provisioning Profiles"

  if [[ ! -d "${cache_dir}" ]]; then
    echo "[sign] Profile cache dir not present, nothing to purge"
    return 0
  fi

  python3 - "${cache_dir}" "${bundle_id}" <<'PY'
import pathlib
import plistlib
import subprocess
import sys

cache_dir, bundle_id = pathlib.Path(sys.argv[1]), sys.argv[2]
removed = []
for path in cache_dir.glob("*.provisionprofile"):
    # security cms 解出 CMS 信封里的 plist，失败则跳过，不误删其他项目文件
    proc = subprocess.run(
        ["/usr/bin/security", "cms", "-D", "-i", str(path)],
        capture_output=True,
        check=False,
    )
    if proc.returncode != 0 or not proc.stdout:
        continue
    try:
        profile = plistlib.loads(proc.stdout)
    except Exception:  # noqa: BLE001
        continue
    entitlements = profile.get("Entitlements") or {}
    team = entitlements.get("com.apple.developer.team-identifier", "")
    app_id = entitlements.get("com.apple.application-identifier", "")
    prefix = f"{team}.{bundle_id}" if team else bundle_id
    if app_id.startswith(prefix):
        path.unlink()
        removed.append(path.name)

print(f"[sign] Purged {len(removed)} cached profile(s)" + (f": {', '.join(removed)}" if removed else ""))
PY
}

# 用 Apple Development 身份对扩展与宿主 App 重新签名。
# 顺序必须由内向外：先 .appex 再 .app，反了会破坏外层签名。
post_sign_safari_app() {
  local app_path="$1"
  local configuration="$2"
  local identity app_xcent appex_xcent appex_path

  identity="$(detect_apple_development_identity)"
  if [[ -z "${identity}" ]]; then
    echo "[sign] Skip post-sign: no Apple Development identity found"
    return 0
  fi

  appex_path="${app_path}/Contents/PlugIns/${SAFARI_APP_NAME} Extension.appex"
  app_xcent="${SAFARI_BUILD_DIR}/Build/Intermediates.noindex/${SAFARI_APP_NAME}.build/${configuration}/${SAFARI_APP_NAME} (macOS).build/${SAFARI_APP_NAME}.app.xcent"
  appex_xcent="${SAFARI_BUILD_DIR}/Build/Intermediates.noindex/${SAFARI_APP_NAME}.build/${configuration}/${SAFARI_APP_NAME} Extension (macOS).build/${SAFARI_APP_NAME} Extension.appex.xcent"

  if [[ ! -d "${appex_path}" || ! -f "${app_xcent}" || ! -f "${appex_xcent}" ]]; then
    echo "[sign] Skip post-sign: signing inputs missing"
    return 0
  fi

  echo "[sign] Post-sign Safari app with Apple Development identity: ${identity}"
  /usr/bin/codesign --force --sign "${identity}" --entitlements "${appex_xcent}" --timestamp=none --options runtime "${appex_path}"
  /usr/bin/codesign --force --sign "${identity}" --entitlements "${app_xcent}" --timestamp=none --options runtime "${app_path}"
  /usr/bin/codesign --verify --verbose=2 "${appex_path}"
  /usr/bin/codesign --verify --verbose=2 "${app_path}"
}

# 校验宿主 App 与扩展双方都带稳定存储的 App Group（应用组）。
# 缺任一侧，Safari 扩展就读写不到共享数据兜底，必须让流程失败而不是静默通过。
verify_stable_storage_entitlements() {
  local app_path="$1"
  local appex_path="${app_path}/Contents/PlugIns/${SAFARI_APP_NAME} Extension.appex"
  local expected_group="${SAFARI_APP_GROUP_ID:-group.com.aeroluna.homepage.safari}"
  local target entitlements

  for target in "$app_path" "$appex_path"; do
    entitlements="$(/usr/bin/codesign -d --entitlements :- "$target" 2>/dev/null || true)"
    if [[ "$entitlements" != *"$expected_group"* ]]; then
      echo "[sign] ERROR: stable-storage App Group missing from signed target: $target" >&2
      exit 1
    fi
  done
  echo "[sign] Verified stable-storage App Group -> $expected_group"
}
