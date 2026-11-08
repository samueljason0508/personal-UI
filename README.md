# personal-UI

A local control panel for the things that are otherwise scattered across `lsof`
output, Launch Services, and dotfiles: listening ports, installed apps, the
global `AGENTS.md`, omp skills, and MCP servers.

Bun server + one HTML file. No build step, no framework. Binds `127.0.0.1` only.

## Run

**omp-panel.app** - double-click it (or drag it to the Dock). It starts the
server if it isn't already running and opens the panel in its own
chrome-less browser window (`--app=` mode: no tabs, no address bar), so it
behaves like a native app with no terminal involved. The server itself runs
as a `~/Library/LaunchAgents` LaunchAgent, independent of the app window's
own lifecycle, so it also comes back up on login - later launches just open
a window against an already-running server.

For a terminal workflow instead:

```sh
bun install
bun server.ts          # http://127.0.0.1:8777
```

Or the CLI launcher, which starts the server if needed and opens it in Orca:

```sh
omp-panel              # start + open
omp-panel stop         # stop
```

`OMP_PANEL_PORT` overrides the port (default `8777`).

## Tabs

| Tab | Shows | Writes |
|---|---|---|
| Ports | Every listening TCP socket with pid and full argv | `kill` (SIGTERM, then SIGKILL) |
| Apps | Every `.app` in `/Applications`, `/System/Applications` (+ `Utilities`), and `~/Applications`, with live running state | `open -b` / app termination |
| AGENTS.md | `~/.agents/AGENTS.md` | the file itself |
| Skills | Every skill in `skills.customDirectories` | `skills.ignoredSkills` in `~/.omp/agent/config.yml` |
| MCP | Servers from every config omp discovers | `disabledServers` in `~/.omp/agent/mcp.json` |

Skill and MCP toggles are the mechanisms omp already reads, not a parallel
registry: `ignoredSkills` hides a skill from discovery, and `disabledServers` is
omp's highest-precedence MCP denylist. Restart omp for changes to take effect.

MCP discovery spans omp, Claude Code (`~/.claude.json`), Codex
(`~/.codex/config.toml`, parsed with `Bun.TOML`), Gemini CLI, Cursor, and
OpenCode. omp resolves duplicate names by precedence rather than merging, so a
server defined in several files shows its winning source and a `shadows N`
badge. Toggling always writes omp's own `mcp.json`, since `disabledServers`
applies across sources by name.

Config writes go through `yaml`'s `parseDocument`, so comments and key order in
`config.yml` survive a toggle.

## Notes

- The panel refuses to kill its own pid.
- The Ports tab lists listeners only (`lsof -sTCP:LISTEN`). A stale `CLOSE_WAIT`
  client socket can still block a `bind()` without appearing here.
- Killing (Ports) is SIGTERM, then SIGKILL if it's still alive after 3s.
- Quitting an app (Apps) asks it to terminate normally - unsaved-document
  prompts included - rather than signalling it. It does not force-quit on a
  timeout, so an app blocked on its own dialog will still show as running.
- Running state comes from matching `ps` output against each app's
  `Contents/MacOS/<executable>`, not `tell application "System Events"`:
  Apple Events need per-app Automation (TCC) permission, which a
  LaunchAgent has no way to be granted - the consent prompt has nowhere to
  show itself, so the call hangs instead of failing.
