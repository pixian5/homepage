#!/usr/bin/env bash
# Safari 宿主 App 与扩展的公共签名函数库。
# 由 scripts/build-macos.command 与 scripts/safari-refresh-signing.sh 共同 source。
#
# 2026-10-24 方案 B（无沙箱共享文件）：
#   macOS 27 上，带 App Sandbox / App Group 的 bundle 没有内嵌描述文件会被
#   launchd/AMFI 直接 SIGKILL；扩展沙箱的 temporary-exception 也无法可靠写入
#   真实用户目录（实测 storage_failed）。因此改为：
#   - 宿主 App 签空 entitlement（带沙箱无 profile 会被 SIGKILL）；
#   - 扩展保留沙箱（去掉后 Safari 根本不注册它），只给共享目录加临时例外；
#   - 两端都不再需要 provisioning profile，也就没有 7 天续期。
#
# source 前调用方必须已定义：
#   SAFARI_APP_NAME  宿主 App 名称，例如 "我的首页 Safari"
#   SAFARI_BUILD_DIR xcodebuild 的 -derivedDataPath
# 可选：
#   SAFARI_APP_GROUP_ID 旧版 App Group 标识，仅用于首次迁移旧数据

# 从钥匙串取第一个可用的 Apple Development（苹果开发）签名身份。
detect_apple_development_identity() {
  security find-identity -p codesigning -v 2>/dev/null \
    | sed -n 's/.*"\(Apple Development: .* ([A-Z0-9]\{10\})\)".*/\1/p' \
    | head -n 1
}

# 稳定存储目录：用户主目录下的普通路径，宿主与扩展共享。
safari_shared_storage_dir() {
  printf '%s/Library/Application Support/我的首页' "${HOME}"
}

# 首次使用新路径时，把旧 App Group 文件迁移过来。
# 只在目标不存在时复制，绝不覆盖新数据；旧文件原样保留作为备份。
migrate_safari_app_group_storage() {
  local target_dir target_file legacy_file
  target_dir="$(safari_shared_storage_dir)"
  target_file="${target_dir}/homepage-data.json"
  legacy_file="${HOME}/Library/Group Containers/${SAFARI_APP_GROUP_ID:-group.com.aeroluna.homepage.safari}/homepage-data.json"

  if [[ -f "${target_file}" ]]; then
    echo "[sign] Shared storage already present: ${target_file}"
    return 0
  fi
  if [[ ! -f "${legacy_file}" ]]; then
    echo "[sign] No legacy App Group storage to migrate"
    return 0
  fi

  mkdir -p "${target_dir}"
  cp -p "${legacy_file}" "${target_file}"
  if ! cmp -s "${legacy_file}" "${target_file}"; then
    echo "[sign] ERROR: migrated storage differs from source" >&2
    return 1
  fi
  echo "[sign] Migrated legacy App Group storage -> ${target_file}"
}

# 用 Apple Development 身份手工签名，不申请、不内嵌描述文件。
# 顺序必须由内向外：先 .appex 再 .app，反了会破坏外层签名。
post_sign_safari_app() {
  local app_path="$1"
  local project_root="$2"
  local identity appex_path app_ent appex_ent

  identity="$(detect_apple_development_identity)"
  if [[ -z "${identity}" ]]; then
    echo "[sign] ERROR: no Apple Development identity found" >&2
    return 1
  fi

  appex_path="${app_path}/Contents/PlugIns/${SAFARI_APP_NAME} Extension.appex"
  app_ent="${project_root}/macOS (App)/HomepageSafari.entitlements"
  appex_ent="${project_root}/macOS (Extension)/HomepageSafariExtension.entitlements"

  if [[ ! -d "${appex_path}" || ! -f "${app_ent}" || ! -f "${appex_ent}" ]]; then
    echo "[sign] ERROR: signing inputs missing under ${app_path}" >&2
    return 1
  fi

  echo "[sign] Manual sign without provisioning profile: ${identity}"
  /usr/bin/codesign --force --sign "${identity}" --entitlements "${appex_ent}" \
    --timestamp=none --options runtime --generate-entitlement-der "${appex_path}"
  /usr/bin/codesign --force --sign "${identity}" --entitlements "${app_ent}" \
    --timestamp=none --options runtime --generate-entitlement-der "${app_path}"
  /usr/bin/codesign --verify --verbose=2 "${appex_path}"
  /usr/bin/codesign --verify --verbose=2 "${app_path}"
}

# 删掉构建目录里已经拷进 /Applications 的那份宿主 App 与游离扩展。
# 只靠 lsregister -u 注销源路径不够，Safari 仍会从构建产物目录加载扩展。
prune_safari_build_products() {
  local configuration="${1:-Release}"
  local products_dir="${SAFARI_BUILD_DIR}/Build/Products/${configuration}"
  local app="${products_dir}/${SAFARI_APP_NAME}.app"
  local appex="${products_dir}/${SAFARI_APP_NAME} Extension.appex"
  local removed=0 target

  for target in "${app}" "${appex}"; do
    if [[ -e "${target}" ]]; then
      rm -rf "${target}"
      removed=$((removed + 1))
    fi
  done
  echo "[sign] Pruned ${removed} build product(s); Safari will only see the /Applications copy"
}

# 校验方案 B 的权限边界：
#   - 宿主 App 不能带沙箱（否则无 profile 会被 SIGKILL）；
#   - 扩展必须带沙箱和共享目录例外（否则读不到数据）；
#   - 两端都不能再出现 App Group。
verify_shared_storage_entitlements() {
  local app_path="$1"
  local appex_path="${app_path}/Contents/PlugIns/${SAFARI_APP_NAME} Extension.appex"
  local app_ent appex_ent

  app_ent="$(/usr/bin/codesign -d --entitlements :- "${app_path}" 2>/dev/null || true)"
  appex_ent="$(/usr/bin/codesign -d --entitlements :- "${appex_path}" 2>/dev/null || true)"

  if [[ "${app_ent}" == *"com.apple.security.app-sandbox"* ]]; then
    echo "[sign] ERROR: host app still has app-sandbox; without a profile it will be SIGKILLed" >&2
    return 1
  fi
  if [[ "${appex_ent}" != *"com.apple.security.app-sandbox"* ]]; then
    echo "[sign] ERROR: appex lost its sandbox; Safari will not register it" >&2
    return 1
  fi
  if [[ "${appex_ent}" != *"/Library/Application Support/我的首页/"* ]]; then
    echo "[sign] ERROR: appex is missing the shared storage exception" >&2
    return 1
  fi
  if [[ "${app_ent}" == *"application-groups"* || "${appex_ent}" == *"application-groups"* ]]; then
    echo "[sign] ERROR: legacy App Group entitlement still present" >&2
    return 1
  fi
  echo "[sign] Verified shared storage entitlements (host unsandboxed, appex scoped)"
}
