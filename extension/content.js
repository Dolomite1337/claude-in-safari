// Claude in Safari — page-load wake signal.
// Every page load nudges the background worker so it reconnects to the bridge
// even after Safari suspends it. Fire-and-forget; errors are expected when the
// worker is mid-restart.
try {
  (globalThis.browser ?? globalThis.chrome).runtime.sendMessage({ type: "wake" }).catch(() => {});
} catch {}
