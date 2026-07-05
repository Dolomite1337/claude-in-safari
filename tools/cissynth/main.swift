// cissynth — coordinate-input helper for Claude in Safari.
//
// The Safari extension's JS cannot synthesize real OS-level mouse/keyboard
// events (no chrome.debugger in Safari). This tiny CLI does it with CGEvent.
// The bridge daemon shells out to it for the safari_computer_* tools.
//
// Usage / exit codes:
//   cissynth probe                 → 0 if Accessibility granted, 3 if not
//   cissynth click <x> <y> [left|right]
//   cissynth type "<text>"
//   cissynth key "<chord>"         e.g. Return, Escape, Tab, cmd+t, cmd+shift+r
//
// Exit 0 = success (prints JSON), 3 = needs Accessibility, 2 = bad usage,
// 1 = other error.

import Foundation
import CoreGraphics
import ApplicationServices

func fail(_ msg: String, _ code: Int32) -> Never {
    FileHandle.standardError.write((msg + "\n").data(using: .utf8)!)
    exit(code)
}
func ok(_ obj: [String: Any] = [:]) -> Never {
    if let d = try? JSONSerialization.data(withJSONObject: obj), let s = String(data: d, encoding: .utf8) {
        print(s)
    } else { print("{}") }
    exit(0)
}

// Trusted for Accessibility? (Required to post events into other apps.)
func accessibilityGranted() -> Bool {
    return AXIsProcessTrusted()
}

func postMouseClick(x: Double, y: Double, right: Bool) {
    let pt = CGPoint(x: x, y: y)
    let src = CGEventSource(stateID: .combinedSessionState)
    let (down, up, btn): (CGEventType, CGEventType, CGMouseButton) = right
        ? (.rightMouseDown, .rightMouseUp, .right)
        : (.leftMouseDown, .leftMouseUp, .left)
    CGEvent(mouseEventSource: src, mouseType: .mouseMoved, mouseCursorPosition: pt, mouseButton: .left)?.post(tap: .cghidEventTap)
    CGEvent(mouseEventSource: src, mouseType: down, mouseCursorPosition: pt, mouseButton: btn)?.post(tap: .cghidEventTap)
    CGEvent(mouseEventSource: src, mouseType: up, mouseCursorPosition: pt, mouseButton: btn)?.post(tap: .cghidEventTap)
}

func typeText(_ text: String) {
    let src = CGEventSource(stateID: .combinedSessionState)
    for scalar in text.unicodeScalars {
        var utf16 = Array(String(scalar).utf16)
        if let down = CGEvent(keyboardEventSource: src, virtualKey: 0, keyDown: true) {
            down.keyboardSetUnicodeString(stringLength: utf16.count, unicodeString: &utf16)
            down.post(tap: .cghidEventTap)
        }
        if let up = CGEvent(keyboardEventSource: src, virtualKey: 0, keyDown: false) {
            up.keyboardSetUnicodeString(stringLength: utf16.count, unicodeString: &utf16)
            up.post(tap: .cghidEventTap)
        }
    }
}

// Named keys → virtual keycodes.
let namedKeys: [String: CGKeyCode] = [
    "return": 0x24, "enter": 0x24, "tab": 0x30, "space": 0x31, "delete": 0x33,
    "escape": 0x35, "esc": 0x35, "left": 0x7B, "right": 0x7C, "down": 0x7D,
    "up": 0x7E, "home": 0x73, "end": 0x77, "pageup": 0x74, "pagedown": 0x79,
    "a": 0x00, "c": 0x08, "v": 0x09, "x": 0x07, "z": 0x06, "t": 0x11,
    "w": 0x0D, "r": 0x0F, "l": 0x25, "f": 0x03, "n": 0x2D,
]

func pressChord(_ chord: String) -> Bool {
    let parts = chord.lowercased().split(separator: "+").map(String.init)
    guard let keyName = parts.last, let code = namedKeys[keyName] else { return false }
    var flags: CGEventFlags = []
    for mod in parts.dropLast() {
        switch mod {
        case "cmd", "command", "meta": flags.insert(.maskCommand)
        case "shift": flags.insert(.maskShift)
        case "alt", "option", "opt": flags.insert(.maskAlternate)
        case "ctrl", "control": flags.insert(.maskControl)
        default: return false
        }
    }
    let src = CGEventSource(stateID: .combinedSessionState)
    if let down = CGEvent(keyboardEventSource: src, virtualKey: code, keyDown: true) {
        down.flags = flags; down.post(tap: .cghidEventTap)
    }
    if let up = CGEvent(keyboardEventSource: src, virtualKey: code, keyDown: false) {
        up.flags = flags; up.post(tap: .cghidEventTap)
    }
    return true
}

let args = Array(CommandLine.arguments.dropFirst())
guard let cmd = args.first else { fail("usage: cissynth <probe|click|type|key>", 2) }

switch cmd {
case "probe":
    accessibilityGranted() ? ok(["accessibility": true]) : fail("accessibility not granted", 3)

case "request":
    // Prompt the user and register this binary in the Accessibility list so it
    // appears with a toggle in System Settings › Privacy & Security.
    let opts = [kAXTrustedCheckOptionPrompt.takeUnretainedValue() as String: true] as CFDictionary
    let trusted = AXIsProcessTrustedWithOptions(opts)
    ok(["accessibility": trusted, "prompted": true])

case "click":
    guard args.count >= 3, let x = Double(args[1]), let y = Double(args[2]) else { fail("usage: cissynth click <x> <y> [left|right]", 2) }
    if !accessibilityGranted() { fail("accessibility not granted", 3) }
    postMouseClick(x: x, y: y, right: args.count >= 4 && args[3] == "right")
    ok(["clicked": ["x": x, "y": y]])

case "type":
    guard args.count >= 2 else { fail("usage: cissynth type <text>", 2) }
    if !accessibilityGranted() { fail("accessibility not granted", 3) }
    typeText(args[1])
    ok(["typed": args[1].count])

case "key":
    guard args.count >= 2 else { fail("usage: cissynth key <chord>", 2) }
    if !accessibilityGranted() { fail("accessibility not granted", 3) }
    if pressChord(args[1]) { ok(["key": args[1]]) } else { fail("unknown key/chord: \(args[1])", 1) }

default:
    fail("unknown command: \(cmd)", 2)
}
