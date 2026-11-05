# personal-UI

A local control panel for the things that are otherwise scattered across `lsof`
output and dotfiles: listening ports, the global `AGENTS.md`, omp skills, and MCP
servers.

Bun server + one HTML file. No build step, no framework. Binds `127.0.0.1` only.

## Run

```sh
bun install
bun server.ts          # http://127.0.0.1:8777
```

Or use the launcher, which starts the server if needed and opens it in Orca:

```sh
omp-panel              # start + open
omp-panel stop         # stop
```

`OMP_PANEL_PORT` overrides the port (default `8777`).

## Tabs

| Tab | Shows | Writes |
|---|---|---|
| Ports | Every listening TCP socket with pid and full argv | `kill` (SIGTERM) |
| AGENTS.md | `~/.agents/AGENTS.md` | the file itself |
| Skills | Every skill in `skills.customDirectories` | `skills.ignoredSkills` in `~/.omp/agent/config.yml` |
| MCP | Servers in `~/.omp/agent/mcp.json` | `disabledServers` in that file |

Skill and MCP toggles are the mechanisms omp already reads, not a parallel
registry: `ignoredSkills` hides a skill from discovery, and `disabledServers` is
omp's highest-precedence MCP denylist. Restart omp for changes to take effect.

Config writes go through `yaml`'s `parseDocument`, so comments and key order in
`config.yml` survive a toggle.

## Notes

- The panel refuses to kill its own pid.
- The Ports tab lists listeners only (`lsof -sTCP:LISTEN`). A stale `CLOSE_WAIT`
  client socket can still block a `bind()` without appearing here.
- Killing is SIGTERM. Escalate manually if a process ignores it.
