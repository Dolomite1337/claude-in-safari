// Coordinate mapping for computer-use on Safari.
//
// Safari extensions have no debugger-based viewport input (unlike Chrome), so a
// coordinate click must be synthesized at the OS level via CGEvent, which uses
// SCREEN points. This maps a viewport coordinate — CSS points, or screenshot
// pixels when fromScreenshot=true — to a screen point.
//
// Approximate: it lumps all window chrome (toolbar/tab/URL bar) at the top via
// (outerHeight - innerHeight) and assumes no left inset. Good enough for
// "click near here"; selector-based safari_click is exact and preferred.

export function viewportToScreen(m, x, y, fromScreenshot = false) {
  const dpr = m.dpr || 1;
  const cssX = fromScreenshot ? x / dpr : x;
  const cssY = fromScreenshot ? y / dpr : y;
  const chromeTop = Math.max(0, (m.outerHeight || m.innerHeight || 0) - (m.innerHeight || 0));
  return {
    x: Math.round((m.screenX || 0) + cssX),
    y: Math.round((m.screenY || 0) + chromeTop + cssY),
  };
}
