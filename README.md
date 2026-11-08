# personal-UI

A local control panel for the things that are otherwise scattered across `lsof`
output, `~/git`, and dotfiles: listening ports, your local dev projects, the
global `AGENTS.md`, omp skills, and MCP servers.

Bun server + one HTML file for the panel itself. No build step, no
framework there. The desktop shell (`personalui.app`) is a ~60-line
Swift/AppKit/WebKit native wrapper - not Electron, no bundled runtime -
compiled once with `swiftc` (ships with Xcode Command Line Tools).

## Run

**personalui.app** - lives in this repo but installs to `/Applications`
like any other app, so Spotlight/Launchpad/Dock find it by name and icon:

```sh
swiftc -O personalui.app/Contents/Resources/PersonalUI.swift \
  -o personalui.app/Contents/MacOS/personalui \
  -framework Cocoa -framework WebKit   # only needed after editing the Swift source
cp -R personalui.app /Applications/
```

Double-click it from there (or drag it to the Dock). It's a real native
window - a `WKWebView` with no tabs or address bar, not a browser window -
so it gets its own Dock tile with this app's icon and name instead of
showing up as whatever browser would otherwise host the page. It expects
the repo at `~/git/personal-UI` (same convention as the CLI launcher
below) and starts the server if it isn't already running. The server
itself runs as a `~/Library/LaunchAgents` LaunchAgent, independent of the
window's own lifecycle, so it also comes back up on login - later
launches just open a window against an already-running server, and
quitting the window leaves the server running in the background.

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
| Apps | Every `~/git` repo with a `dev` or `start` script in `package.json`, with live running state | starts/stops its dev server |
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
- Stopping a project (Apps) stops its whole process tree (launchd job-level
  kill), so a bundler's child processes do not leak behind.
- Running state comes from matching `lsof -d cwd` against each project's
  path, not the process argv: the bundler binary rarely has the project
  path in it, but `npm run dev` et al. always execute with cwd set there.
- Starting a project picks its package manager from the lockfile checked
  in (`bun.lock(b)`, `pnpm-lock.yaml`, `yarn.lock`, else `npm`) and runs it
  as its own `~/Library/LaunchAgents` job, same reasoning as the panel's
  own server: a plain background child would die with this server on its
  next restart.
- `OMP_PANEL_GIT_DIR` overrides the projects root (default `~/git`).
