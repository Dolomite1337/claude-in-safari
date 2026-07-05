//
//  SafariWebExtensionHandler.swift
//  Claude in Safari Extension
//
//  Native-messaging bridge. WebKit blocks ws://localhost from extension JS,
//  so the JS long-polls this handler instead, and THIS process (entitled with
//  com.apple.security.network.client) holds the WebSocket to the local daemon.
//
//  JS protocol (via browser.runtime.sendNativeMessage):
//    {cmd:"poll"}                  → waits up to POLL_TIMEOUT for a queued tool
//                                    call from the daemon → {type:"tool",...}
//                                    or {type:"none"} on timeout
//    {cmd:"result", id, ok, ...}   → forwards the tool result to the daemon
//    {cmd:"status"}                → {connected: Bool} (daemon link state)
//

import SafariServices

private let POLL_TIMEOUT: TimeInterval = 15

/// Singleton WebSocket client to the bridge daemon. Lives as long as Safari
/// keeps this extension process alive; reconnects lazily on demand.
final class DaemonLink {
    static let shared = DaemonLink()

    private let session = URLSession(configuration: .default)
    private var task: URLSessionWebSocketTask?
    private var connected = false
    private var queue: [[String: Any]] = []
    private let cond = NSCondition()
    // One-shot request/response for daemon-side tools (e.g. capabilities),
    // keyed by request id.
    private var pendingResults: [String: ([String: Any]) -> Void] = [:]
    private let resultsLock = NSLock()

    func ensureConnected() {
        cond.lock(); defer { cond.unlock() }
        if connected, task != nil { return }
        guard let url = URL(string: "ws://127.0.0.1:8787") else { return }
        let t = session.webSocketTask(with: url)
        task = t
        connected = true
        t.resume()
        sendLocked(["type": "hello", "role": "extension", "platform": "macos"])
        receiveLoop(t)
    }

    var isConnected: Bool {
        cond.lock(); defer { cond.unlock() }
        return connected && task != nil
    }

    private func receiveLoop(_ t: URLSessionWebSocketTask) {
        t.receive { [weak self] result in
            guard let self else { return }
            switch result {
            case .failure:
                self.cond.lock()
                self.connected = false
                self.task = nil
                self.cond.unlock()
            case .success(let message):
                var text: String?
                switch message {
                case .string(let s): text = s
                case .data(let d): text = String(data: d, encoding: .utf8)
                @unknown default: break
                }
                if let text,
                   let data = text.data(using: .utf8),
                   let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any] {
                    switch obj["type"] as? String {
                    case "ping":
                        self.send(["type": "pong"])
                    case "result":
                        // Fulfill a one-shot daemon-tool request if we're waiting on it;
                        // otherwise it's an extension-tool result (handled by the JS side).
                        if let id = obj["id"] as? String {
                            self.resultsLock.lock()
                            let cb = self.pendingResults.removeValue(forKey: id)
                            self.resultsLock.unlock()
                            cb?(obj)
                        }
                    case "tool", "chat.delta", "chat.done", "approval.request":
                        self.cond.lock()
                        self.queue.append(obj)
                        self.cond.signal()
                        self.cond.unlock()
                    default:
                        break
                    }
                }
                self.receiveLoop(t)
            }
        }
    }

    func send(_ obj: [String: Any]) {
        cond.lock(); defer { cond.unlock() }
        sendLocked(obj)
    }

    private func sendLocked(_ obj: [String: Any]) {
        guard let t = task,
              let data = try? JSONSerialization.data(withJSONObject: obj),
              let s = String(data: data, encoding: .utf8) else { return }
        t.send(.string(s)) { [weak self] error in
            if error != nil {
                guard let self else { return }
                self.cond.lock()
                self.connected = false
                self.task = nil
                self.cond.unlock()
            }
        }
    }

    /// Send a daemon-side tool request and block up to `timeout` for its result.
    func request(tool: String, timeout: TimeInterval) -> [String: Any] {
        ensureConnected()
        let id = UUID().uuidString
        let sem = DispatchSemaphore(value: 0)
        var out: [String: Any] = ["ok": false, "code": "TIMEOUT", "error": "daemon did not respond"]
        resultsLock.lock()
        pendingResults[id] = { obj in out = obj; sem.signal() }
        resultsLock.unlock()
        send(["type": "tool", "id": id, "tool": tool, "params": [:]])
        if sem.wait(timeout: .now() + timeout) == .timedOut {
            resultsLock.lock(); pendingResults.removeValue(forKey: id); resultsLock.unlock()
        }
        return out
    }

    /// Blocks up to `timeout` waiting for a tool call pushed by the daemon.
    func poll(timeout: TimeInterval) -> [String: Any]? {
        ensureConnected()
        let deadline = Date().addingTimeInterval(timeout)
        cond.lock(); defer { cond.unlock() }
        while queue.isEmpty {
            if !cond.wait(until: deadline) { return nil }
        }
        return queue.removeFirst()
    }
}

class SafariWebExtensionHandler: NSObject, NSExtensionRequestHandling {

    func beginRequest(with context: NSExtensionContext) {
        let item = context.inputItems.first as? NSExtensionItem
        let message = (item?.userInfo?[SFExtensionMessageKey]) as? [String: Any] ?? [:]
        let cmd = message["cmd"] as? String ?? ""

        switch cmd {
        case "poll":
            // Long-poll off the main thread; reply when a tool call arrives
            // or the window closes.
            DispatchQueue.global(qos: .userInitiated).async {
                let tool = DaemonLink.shared.poll(timeout: POLL_TIMEOUT)
                self.reply(context, tool ?? ["type": "none"])
            }
        case "result":
            var payload = message
            payload.removeValue(forKey: "cmd")
            payload["type"] = "result"
            DaemonLink.shared.ensureConnected()
            DaemonLink.shared.send(payload)
            reply(context, ["ok": true])
        case "chat":
            var payload = message
            payload.removeValue(forKey: "cmd")
            payload["type"] = "chat"
            DaemonLink.shared.ensureConnected()
            DaemonLink.shared.send(payload)
            reply(context, ["ok": true])
        case "chatstop":
            DaemonLink.shared.ensureConnected()
            DaemonLink.shared.send(["type": "chatstop"])
            reply(context, ["ok": true])
        case "setmode":
            DaemonLink.shared.ensureConnected()
            DaemonLink.shared.send(["type": "setmode", "mode": message["mode"] as? String ?? "free"])
            reply(context, ["ok": true])
        case "approval":
            DaemonLink.shared.ensureConnected()
            DaemonLink.shared.send(["type": "approval", "id": message["id"] as? String ?? "", "decision": message["decision"] as? String ?? "deny"])
            reply(context, ["ok": true])
        case "status":
            reply(context, ["connected": DaemonLink.shared.isConnected])
        case "capabilities":
            DispatchQueue.global(qos: .userInitiated).async {
                let r = DaemonLink.shared.request(tool: "capabilities", timeout: 4)
                self.reply(context, r)
            }
        case "setserpkey":
            DaemonLink.shared.ensureConnected()
            DaemonLink.shared.send(["type": "setserpkey", "key": message["key"] as? String ?? ""])
            reply(context, ["ok": true])
        case "clearserpkey":
            DaemonLink.shared.ensureConnected()
            DaemonLink.shared.send(["type": "clearserpkey"])
            reply(context, ["ok": true])
        case "setanthropickey":
            DaemonLink.shared.ensureConnected()
            DaemonLink.shared.send(["type": "setanthropickey", "key": message["key"] as? String ?? ""])
            reply(context, ["ok": true])
        case "clearanthropickey":
            DaemonLink.shared.ensureConnected()
            DaemonLink.shared.send(["type": "clearanthropickey"])
            reply(context, ["ok": true])
        case "setbrain":
            DaemonLink.shared.ensureConnected()
            DaemonLink.shared.send(["type": "setbrain", "brain": message["brain"] as? String ?? "claude-code"])
            reply(context, ["ok": true])
        default:
            reply(context, ["error": "unknown cmd"])
        }
    }

    private func reply(_ context: NSExtensionContext, _ obj: [String: Any]) {
        let response = NSExtensionItem()
        response.userInfo = [SFExtensionMessageKey: obj]
        context.completeRequest(returningItems: [response], completionHandler: nil)
    }
}
