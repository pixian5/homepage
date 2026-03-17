//
//  ViewController.swift
//  Shared (App)
//
//  Created by 🌞 🐑 on 2026-03-17.
//

import WebKit

#if os(iOS)
import UIKit
typealias PlatformViewController = UIViewController
#elseif os(macOS)
import Cocoa
import SafariServices
typealias PlatformViewController = NSViewController
#endif

let extensionBundleIdentifier = "__SAFARI_EXTENSION_BUNDLE_ID__"

class ViewController: PlatformViewController, WKNavigationDelegate, WKScriptMessageHandler {

    @IBOutlet var webView: WKWebView!

    override func viewDidLoad() {
        super.viewDidLoad()

        self.webView.navigationDelegate = self

#if os(iOS)
        self.webView.scrollView.isScrollEnabled = false
#endif

        self.webView.configuration.userContentController.add(self, name: "controller")

        self.webView.loadFileURL(Bundle.main.url(forResource: "Main", withExtension: "html")!, allowingReadAccessTo: Bundle.main.resourceURL!)
    }

    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
#if os(iOS)
        webView.evaluateJavaScript("show('ios')")
#elseif os(macOS)
        webView.evaluateJavaScript("show('mac')")

        SFSafariExtensionManager.getStateOfSafariExtension(withIdentifier: extensionBundleIdentifier) { (state, error) in
            guard let state = state, error == nil else {
                return
            }

            DispatchQueue.main.async {
                if #available(macOS 13, *) {
                    webView.evaluateJavaScript("show('mac', \(state.isEnabled), true)")
                } else {
                    webView.evaluateJavaScript("show('mac', \(state.isEnabled), false)")
                }
            }
        }
#endif
    }

    func userContentController(_ userContentController: WKUserContentController, didReceive message: WKScriptMessage) {
#if os(macOS)
        if (message.body as! String != "open-preferences") {
            return
        }

        SFSafariApplication.showPreferencesForExtension(withIdentifier: extensionBundleIdentifier) { error in
            guard error == nil else {
                DispatchQueue.main.async {
                    self.openSafariSettingsFallback()
                }
                return
            }

            DispatchQueue.main.async {
                NSApp.terminate(self)
            }
        }
#endif
    }

}

#if os(macOS)
private extension ViewController {
    func openSafariSettingsFallback() {
        if runAppleScript("""
        tell application "Safari"
            activate
        end tell
        delay 0.5
        tell application "System Events"
            tell process "Safari"
                if exists menu item "设置..." of menu "Safari" of menu bar 1 then
                    click menu item "设置..." of menu "Safari" of menu bar 1
                    return
                end if
                if exists menu item "Preferences..." of menu "Safari" of menu bar 1 then
                    click menu item "Preferences..." of menu "Safari" of menu bar 1
                    return
                end if
                keystroke "," using command down
            end tell
        end tell
        """) {
            NSApp.terminate(self)
            return
        }

        NSWorkspace.shared.open(URL(fileURLWithPath: "/Applications/Safari.app"))
        showManualInstructionsAlert()
    }

    @discardableResult
    func runAppleScript(_ source: String) -> Bool {
        guard let script = NSAppleScript(source: source) else {
            return false
        }

        var error: NSDictionary?
        script.executeAndReturnError(&error)
        return error == nil
    }

    func showManualInstructionsAlert() {
        let alert = NSAlert()
        alert.messageText = "请手动打开 Safari 扩展设置"
        alert.informativeText = "如果按钮没有自动跳转，请打开 Safari，然后进入“设置 -> 扩展”，启用“我的首页”。"
        alert.addButton(withTitle: "知道了")
        alert.runModal()
    }
}
#endif
