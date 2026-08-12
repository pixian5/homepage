import SafariServices

private let appGroupIdentifier = "group.com.aeroluna.homepage.safari"
private let storageFileName = "homepage-data.json"

final class SafariWebExtensionHandler: NSObject, NSExtensionRequestHandling {
    private func storageURL() -> URL? {
        FileManager.default
            .containerURL(forSecurityApplicationGroupIdentifier: appGroupIdentifier)?
            .appendingPathComponent(storageFileName, isDirectory: false)
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
            response(["ok": false, "error": "app_group_unavailable"], context: context)
            return
        }

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
