// Native shell for the panel: a plain WKWebView in a titled NSWindow, no
// tabs, no address bar. Running as this app's own compiled executable
// (rather than opening a window inside Chrome) is what gives it a real
// Dock tile with this app's own icon and name, instead of showing up as
// whatever browser happens to host the page.
import Cocoa
import WebKit

final class AppDelegate: NSObject, NSApplicationDelegate {
	var window: NSWindow!
	var webView: WKWebView!

	func applicationDidFinishLaunching(_ notification: Notification) {
		guard let url = startServer() else {
			fail("personalui: the server did not start. Check /tmp/personalui-server.log.")
			return
		}

		let width: CGFloat = 1180
		let height: CGFloat = 860
		let screen = NSScreen.main?.visibleFrame ?? NSRect(x: 0, y: 0, width: width, height: height)
		let rect = NSRect(
			x: screen.midX - width / 2,
			y: screen.midY - height / 2,
			width: width,
			height: height
		)

		window = NSWindow(
			contentRect: rect,
			styleMask: [.titled, .closable, .miniaturizable, .resizable],
			backing: .buffered,
			defer: false
		)
		window.title = "personalui"
		window.titlebarAppearsTransparent = false

		webView = WKWebView(frame: NSRect(origin: .zero, size: rect.size))
		webView.autoresizingMask = [.width, .height]
		webView.load(URLRequest(url: url))
		window.contentView = webView

		window.makeKeyAndOrderFront(nil)
		NSApp.activate(ignoringOtherApps: true)
	}

	func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool {
		true
	}

	/// Runs the bundled start-server.sh synchronously and returns the panel
	/// URL it prints on success, or nil if it exited nonzero.
	private func startServer() -> URL? {
		guard let scriptPath = Bundle.main.path(forResource: "start-server", ofType: "sh") else {
			return nil
		}
		let process = Process()
		process.executableURL = URL(fileURLWithPath: "/bin/bash")
		process.arguments = [scriptPath]
		let pipe = Pipe()
		process.standardOutput = pipe
		do {
			try process.run()
		} catch {
			return nil
		}
		process.waitUntilExit()
		guard process.terminationStatus == 0 else { return nil }
		let data = pipe.fileHandleForReading.readDataToEndOfFile()
		let out = String(data: data, encoding: .utf8)?.trimmingCharacters(in: .whitespacesAndNewlines)
		guard let out, let url = URL(string: out) else { return nil }
		return url
	}

	private func fail(_ message: String) {
		let alert = NSAlert()
		alert.messageText = "personalui"
		alert.informativeText = message
		alert.runModal()
		NSApp.terminate(nil)
	}
}

let app = NSApplication.shared
app.setActivationPolicy(.regular)
let delegate = AppDelegate()
app.delegate = delegate
app.run()
