// Unit tests for the viewport→screen coordinate mapping (computer-use).
import { viewportToScreen } from "./coords.mjs";

let pass = 0, fail = 0;
const eq = (n, got, want) => { const ok = got.x === want.x && got.y === want.y; if (ok) { pass++; console.log(`  ✅ ${n}`); } else { fail++; console.log(`  ❌ ${n} got ${JSON.stringify(got)} want ${JSON.stringify(want)}`); } };

// Window at screen (100,80), 40px chrome at top (outer 840 vs inner 800), dpr 1.
const m1 = { screenX: 100, screenY: 80, innerWidth: 1200, innerHeight: 800, outerWidth: 1200, outerHeight: 840, dpr: 1 };
eq("origin maps past chrome", viewportToScreen(m1, 0, 0), { x: 100, y: 120 });          // 80 + (840-800)
eq("viewport point offset", viewportToScreen(m1, 300, 200), { x: 400, y: 320 });

// Retina dpr 2 with screenshot pixels → divide by dpr.
const m2 = { screenX: 0, screenY: 0, innerWidth: 1440, innerHeight: 900, outerWidth: 1440, outerHeight: 900, dpr: 2 };
eq("screenshot px halved at dpr2", viewportToScreen(m2, 600, 400, true), { x: 300, y: 200 });
eq("css point unaffected by dpr", viewportToScreen(m2, 600, 400, false), { x: 600, y: 400 });

// Missing/degenerate metrics don't throw.
eq("empty metrics → origin-ish", viewportToScreen({}, 10, 20), { x: 10, y: 20 });
eq("no chrome when outer<=inner", viewportToScreen({ screenX: 5, screenY: 5, innerHeight: 800, outerHeight: 800 }, 0, 0), { x: 5, y: 5 });

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
