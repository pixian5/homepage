import Foundation
import SafariServices

// 稳定存储文件位置（方案 B：无沙箱共享文件）。
//
// 历史沿革：
//   2026-08 之前用 App Group 容器 group.com.aeroluna.homepage.safari；
//   2026-10-24 在 macOS 27 上实测发现，带 App Sandbox / App Group 这类受限
//   entitlement 的 bundle 如果没有内嵌描述文件，会被 launchd/AMFI 直接 SIGKILL，
//   导致原生消息永远启动失败、兜底文件自 8-14 起就没再更新。
//   因此改为签「无受限权限」的普通文件路径，使扩展与宿主 App 都无需描述文件。
//
// 沙箱扩展本来会被限制在容器内，为了让扩展能读写同一个文件，
// 构建脚本会额外给扩展签名加上 com.apple.security.temporary-exception.files.home-relative-path.read-write
// （只放开 ~/Library/Application Support/我的首页/ 这一个子目录），宿主 App 不加沙箱、权限不受限。
private let storageDirectoryName = "我的首页"
private let storageFileName = "homepage-data.json"

final class SafariWebExtensionHandler: NSObject, NSExtensionRequestHandling {
    /// 计算稳定存储文件路径；拿不到用户目录时返回 nil，由调用方回 failed。
    private func storageURL() -> URL? {
        // 注意：扩展运行在沙箱里，FileManager.homeDirectoryForCurrentUser 返回的是
        // ~/Library/Containers/<bundle-id>/Data，而不是真实用户目录。必须用 getpwuid
        // 取真实 home，再依靠 temporary-exception 的 home-relative-path 例外访问。
        guard let passwd = getpwuid(getuid()), let homePath = passwd.pointee.pw_dir else {
            return nil
        }
        let home = URL(fileURLWithPath: String(cString: homePath), isDirectory: true)
        let directory = home
            .appendingPathComponent("Library", isDirectory: true)
            .appendingPathComponent("Application Support", isDirectory: true)
            .appendingPathComponent(storageDirectoryName, isDirectory: true)
        return directory.appendingPathComponent(storageFileName, isDirectory: false)
    }

    private func response(_ payload: [String: Any], context: NSExtensionContext) {
        let item = NSExtensionItem()
        if #available(iOS 15.0, macOS 11.0, *) {
            item.userInfo = [SFExtensionMessageKey: payload]
        } else {
            item.userInfo = ["message": payload]
        }
        context.completeRequest(returningItems: [item], completionHandler: nil)
    }

    func beginRequest(with context: NSExtensionContext) {
        let item = context.inputItems.first as? NSExtensionItem
        let rawMessage: Any?
        if #available(iOS 15.0, macOS 11.0, *) {
            rawMessage = item?.userInfo?[SFExtensionMessageKey]
        } else {
            rawMessage = item?.userInfo?["message"]
        }
        guard let message = rawMessage as? [String: Any], let type = message["type"] as? String else {
            response(["ok": false, "error": "invalid_message"], context: context)
            return
        }
        guard let url = storageURL() else {
            response(["ok": false, "error": "storage_path_unavailable"], context: context)
            return
        }
        // 目录可能还没建（首次写入），按需创建
        let directory = url.deletingLastPathComponent()

        do {
            switch type {
            case "homepage.storage.read":
                guard FileManager.default.fileExists(atPath: url.path) else {
                    response(["ok": true, "data": NSNull()], context: context)
                    return
                }
                let data = try Data(contentsOf: url)
                let object = try JSONSerialization.jsonObject(with: data)
                response(["ok": true, "data": object], context: context)
            case "homepage.storage.write":
                guard let object = message["data"], JSONSerialization.isValidJSONObject(object) else {
                    response(["ok": false, "error": "invalid_data"], context: context)
                    return
                }
                try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
                let data = try JSONSerialization.data(withJSONObject: object)
                try data.write(to: url, options: [.atomic])
                response(["ok": true], context: context)
            case "homepage.storage.clear":
                if FileManager.default.fileExists(atPath: url.path) {
                    try FileManager.default.removeItem(at: url)
                }
                response(["ok": true], context: context)
            default:
                response(["ok": false, "error": "unsupported_message"], context: context)
            }
        } catch {
            response(["ok": false, "error": "storage_failed"], context: context)
        }
    }
}
