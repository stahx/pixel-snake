# Bug testing with the browser

When a visual bug, rendering glitch, or UI issue is reported:

1. **Test first** — start the backend (`apps/backend`, default port 3030
   via `.env`/`.env.example`, check for an already-running instance
   before starting another), open the game with the `claude-in-chrome`
   MCP tools, join, and reproduce the issue before writing any fix.
2. **Take screenshots as evidence** — use `mcp__claude-in-chrome__computer`
   with the `screenshot` action. Known caveat: this game's uncapped
   `requestAnimationFrame` loop can starve the extension's screenshot
   capture, causing it to time out ("Script injection timed out"). If it
   fails 2-3 times, don't keep retrying — fall back to
   `mcp__claude-in-chrome__javascript_tool` and pull pixels directly, e.g.
   `document.querySelector('#canvas').toDataURL('image/png')`. That string
   is too long to come back through the tool's own text channel (truncates
   around ~1.5KB) — POST it from the page to a small throwaway local HTTP
   server (a few lines of Node, listening on a scratch port) that writes
   the base64 body to a file, then read that file.
2b. When the browser extension itself is disconnected and can't be
   reconnected, a headless `socket.io-client` script (connect, join,
   drive movement via `change-dir`/`player-speed`, log/patch what you
   need) is a reliable way to verify *server-side* behavior (collisions,
   fog-of-war, growth) without a real browser — it won't tell you
   anything about rendering/CSS/canvas output, only wire data.
3. **Verify fixes** — after applying a fix, test again the same way to
   confirm it's resolved. Prefer numeric/pixel-level verification (e.g.
   `getImageData` diffs, or logging measured values) over eyeballing a
   screenshot when precision matters — screenshots downscaled for display
   can visually hide or exaggerate small differences.

No `browser_lock`/`browser_unlock` step exists in this toolset (that's
from a different MCP server) — call `mcp__claude-in-chrome__tabs_context_mcp`
first if you don't already have a valid tab ID for this session, and clean
up tabs/scratch servers you started when done.
