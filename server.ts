// omp-panel: local control panel for listening ports, AGENTS.md, skills and MCP servers.
// Binds loopback only. Every mutation writes the same files omp itself reads.
import { $ } from "bun";
import { Document, parse, parseDocument } from "yaml";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { mkdir, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";

const HOME = homedir();
const CONFIG_YML = join(HOME, ".omp/agent/config.yml");
const MCP_JSON = join(HOME, ".omp/agent/mcp.json");
const AGENTS_MD = join(HOME, ".agents/AGENTS.md");
const GIT_DIR = process.env.OMP_PANEL_GIT_DIR ?? join(HOME, "git");
const PORT = Number(process.env.OMP_PANEL_PORT ?? 8777);

export interface PortRow {
	port: number;
	pid: number;
	command: string;
	address: string;
	argv: string;
	self: boolean;
}

export interface ProjectRow {
	name: string;
	path: string;
	/** Package manager picked from the lockfile: `bun run dev`, not just `dev`. */
	command: string;
	running: boolean;
}

export interface SkillRow {
	name: string;
	description: string;
	dir: string;
	enabled: boolean;
}

export interface McpRow {
	name: string;
	transport: string;
	target: string;
	enabled: boolean;
	disabledByList: boolean;
	/** Label of the highest-precedence config that defines this server. */
	source: string;
	/** Lower-precedence configs defining the same name; omp ignores these. */
	shadowedBy: string[];
}

export interface McpListing {
	rows: McpRow[];
	/** Where `disabledServers` is written, which may not exist yet. */
	denylistPath: string;
	sources: { label: string; path: string; count: number }[];
}

/** Used by every route, so the content-type stays in one place. */
function json(data: unknown, status = 200): Response {
	return new Response(JSON.stringify(data), {
		status,
		headers: { "content-type": "application/json" },
	});
}

/**
 * Narrow an unknown to a plain object. The assertion runs only after the
 * runtime shape check above it, so the cast cannot be wrong.
 */
function asRecord(value: unknown): Record<string, unknown> | undefined {
	if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
	return value as Record<string, unknown>;
}

function asStringList(value: unknown): string[] {
	if (!Array.isArray(value)) return [];
	return value.filter((v): v is string => typeof v === "string");
}

/** Read a `section.key` string array out of the parsed config document. */
function configStringList(doc: Document, section: string, key: string): string[] {
	const root = asRecord(doc.toJSON());
	const sec = asRecord(root?.[section]);
	return asStringList(sec?.[key]);
}

// ------------------------------------------------------------------- ports

/** pid -> value, from `ps -A -o pid=,<field>=`. The value may contain spaces,
 *  so only the leading pid is split off. */
async function psField(field: "comm" | "command"): Promise<Map<number, string>> {
	const out = await $`ps -A -o pid=,${field}=`.nothrow().text();
	const byPid = new Map<number, string>();
	for (const line of out.split("\n")) {
		const match = line.trim().match(/^(\d+)\s+(.*)$/);
		if (match) byPid.set(Number(match[1]), match[2]!.trim());
	}
	return byPid;
}

/**
 * Listening TCP sockets only: `-sTCP:LISTEN` keeps the list to servers rather
 * than every transient client connection.
 */
async function listPorts(): Promise<PortRow[]> {
	// Two batched ps calls rather than two per listener.
	const [out, comms, argvs] = await Promise.all([
		$`lsof -nP -iTCP -sTCP:LISTEN`.nothrow().text(),
		psField("comm"),
		psField("command"),
	]);
	const seen = new Set<string>();
	const rows: PortRow[] = [];

	for (const line of out.split("\n").slice(1)) {
		const f = line.trim().split(/\s+/);
		if (f.length < 9) continue;
		const address = f[8] ?? "";
		const port = Number(address.match(/:(\d+)$/)?.[1]);
		const pid = Number(f[1]);
		if (!Number.isFinite(port) || !Number.isFinite(pid)) continue;

		// One process can listen on IPv4 and IPv6 for the same port; show it once.
		const key = `${pid}:${port}`;
		if (seen.has(key)) continue;
		seen.add(key);

		// lsof truncates COMMAND to 9 chars and escapes spaces as \x20, so prefer
		// ps `comm` (the executable's basename) and fall back to the lsof column.
		const comm = comms.get(pid);
		const command = comm?.split("/").pop() || (f[0] ?? "?").replace(/\\x20/g, " ");

		rows.push({
			port,
			pid,
			command,
			address,
			argv: argvs.get(pid) ?? "",
			self: pid === process.pid,
		});
	}
	return rows.sort((a, b) => a.port - b.port);
}

export interface KillResult {
	alive: boolean;
	signal: "SIGTERM" | "SIGKILL";
	note: string;
}

/**
 * Actually end the process: SIGTERM, wait for it to go, then SIGKILL.
 *
 * Liveness comes from `ps`, not `kill -0`: a killed process whose parent has
 * not reaped it stays a zombie, and `kill -0` still succeeds on one. A zombie
 * is dead for our purposes - it holds no port and runs no code.
 */
async function killProcess(pid: number): Promise<KillResult> {
	const alive = async (): Promise<boolean> => {
		const state = (await $`ps -p ${pid} -o state=`.nothrow().text()).trim();
		return state.length > 0 && !state.startsWith("Z");
	};

	try {
		process.kill(pid, "SIGTERM");
	} catch {
		return { alive: false, signal: "SIGTERM", note: "already gone" };
	}

	for (let i = 0; i < 12; i++) {
		await Bun.sleep(250);
		if (!(await alive())) return { alive: false, signal: "SIGTERM", note: "exited" };
	}

	try {
		process.kill(pid, "SIGKILL");
	} catch {
		return { alive: false, signal: "SIGKILL", note: "exited" };
	}
	await Bun.sleep(500);
	const stillAlive = await alive();
	return {
		alive: stillAlive,
		signal: "SIGKILL",
		note: stillAlive ? "owned by another user or unkillable" : "killed",
	};
}

// ----------------------------------------------------------------- projects

const PROJECT_LABEL_PREFIX = "dev.omp.panel.project.";

type PackageManager = "bun" | "pnpm" | "yarn" | "npm";

interface ProjectInfo {
	name: string;
	path: string;
	script: "dev" | "start";
	pm: PackageManager;
}

/** LaunchAgent-label-safe slug for a project's directory name. */
function slug(name: string): string {
	return name.replace(/[^a-zA-Z0-9]+/g, "-").toLowerCase();
}

/** Resolve a binary a backgrounded LaunchAgent's bare PATH
 *  (`/usr/bin:/bin:/usr/sbin:/sbin`) would not find, same reasoning as the
 *  `omp-panel.app` launcher's own bun lookup. */
async function resolveBin(name: string): Promise<string | undefined> {
	for (const dir of ["/opt/homebrew/bin", "/usr/local/bin"]) {
		if (await stat(join(dir, name)).catch(() => null)) return join(dir, name);
	}
	const out = await $`command -v ${name}`.nothrow().text();
	return out.trim() || undefined;
}

/** Picks a package manager from the lockfile actually checked in, so
 *  starting a project does not silently install with the wrong one. */
async function detectPackageManager(dir: string): Promise<PackageManager> {
	if (await stat(join(dir, "bun.lock")).catch(() => null)) return "bun";
	if (await stat(join(dir, "bun.lockb")).catch(() => null)) return "bun";
	if (await stat(join(dir, "pnpm-lock.yaml")).catch(() => null)) return "pnpm";
	if (await stat(join(dir, "yarn.lock")).catch(() => null)) return "yarn";
	return "npm";
}

/** Every `~/git` entry that is a git repo with a `dev` or `start` script -
 *  the two conventional names for "run this locally". */
async function findRunnableProjects(): Promise<ProjectInfo[]> {
	const entries = await readdir(GIT_DIR, { withFileTypes: true }).catch(() => []);
	const rows = await Promise.all(
		entries
			.filter((e) => e.isDirectory())
			.map(async (entry): Promise<ProjectInfo | null> => {
				const path = join(GIT_DIR, entry.name);
				const isRepo = await stat(join(path, ".git")).catch(() => null);
				if (!isRepo) return null;
				const raw = await readFile(join(path, "package.json"), "utf8").catch(() => null);
				if (!raw) return null;
				const scripts = asRecord(asRecord(JSON.parse(raw))?.scripts);
				const script = scripts?.dev ? "dev" : scripts?.start ? "start" : undefined;
				if (!script) return null;
				return { name: entry.name, path, script, pm: await detectPackageManager(path) };
			}),
	);
	return rows.filter((r): r is ProjectInfo => r !== null).sort((a, b) => a.name.localeCompare(b.name));
}

/** Every running process's working directory, from `lsof -d cwd`. A
 *  project's dev server is matched on cwd (where `npm run dev` et al.
 *  actually execute) rather than argv, since the bundler binary itself
 *  rarely has the project path in it. */
async function listCwds(): Promise<string[]> {
	const out = await $`lsof -a -d cwd -n -P`.nothrow().text();
	const dirs: string[] = [];
	for (const line of out.split("\n").slice(1)) {
		const f = line.trim().split(/\s+/);
		if (f.length < 9) continue;
		dirs.push(f.slice(8).join(" "));
	}
	return dirs;
}

async function listApps(): Promise<ProjectRow[]> {
	const [projects, cwds] = await Promise.all([findRunnableProjects(), listCwds()]);
	return projects.map((p) => ({
		name: p.name,
		path: p.path,
		command: `${p.pm} run ${p.script}`,
		running: cwds.some((c) => c === p.path || c.startsWith(`${p.path}/`)),
	}));
}

/**
 * Start and stop both go through a dedicated LaunchAgent per project, the
 * same mechanism the panel's own server uses for itself: a plain
 * backgrounded child would share this server's own job and die the next
 * time it restarts, and launchd's job-level stop also takes the whole
 * process tree with it, so a bundler's child processes do not leak behind
 * the way a bare `kill` on just the top pid would.
 */
async function setAppRunning(name: string, running: boolean): Promise<void> {
	const label = PROJECT_LABEL_PREFIX + slug(name);
	const domain = `gui/${process.getuid!()}`;
	await $`launchctl bootout ${domain}/${label}`.nothrow();
	if (!running) return;

	const project = (await findRunnableProjects()).find((p) => p.name === name);
	if (!project) throw new Error(`unknown project ${name}`);
	const bin = await resolveBin(project.pm);
	if (!bin) throw new Error(`${project.pm} not found (checked /opt/homebrew/bin, /usr/local/bin, PATH)`);

	const plistPath = join(HOME, "Library/LaunchAgents", `${label}.plist`);
	const log = join(tmpdir(), `omp-panel-project-${slug(name)}.log`);
	await mkdir(dirname(plistPath), { recursive: true });
	await writeFile(
		plistPath,
		`<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
	<key>Label</key><string>${label}</string>
	<key>ProgramArguments</key>
	<array><string>${bin}</string><string>run</string><string>${project.script}</string></array>
	<key>WorkingDirectory</key><string>${project.path}</string>
	<key>EnvironmentVariables</key>
	<dict>
		<key>PATH</key>
		<string>/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin</string>
	</dict>
	<key>RunAtLoad</key><true/>
	<key>KeepAlive</key><false/>
	<key>ProcessType</key><string>Interactive</string>
	<key>StandardOutPath</key><string>${log}</string>
	<key>StandardErrorPath</key><string>${log}</string>
</dict>
</plist>
`,
		"utf8",
	);
	const result = await $`launchctl bootstrap ${domain} ${plistPath}`.nothrow();
	if (result.exitCode !== 0) throw new Error(`failed to start ${name}: see ${log}`);
}

// ------------------------------------------------------------------- skills

/** Pull `description:` from SKILL.md frontmatter. Uses the real parser so
 *  folded/literal block scalars (`description: >`) resolve to their text. */
function frontmatterDescription(src: string): string {
	if (!src.startsWith("---")) return "";
	const end = src.indexOf("\n---", 3);
	if (end === -1) return "";
	const front = asRecord(parse(src.slice(3, end)));
	return typeof front?.description === "string" ? front.description.trim() : "";
}

async function listSkills(): Promise<SkillRow[]> {
	const doc = parseDocument((await readFile(CONFIG_YML, "utf8").catch(() => "")) || "{}");
	const ignored = new Set(configStringList(doc, "skills", "ignoredSkills"));
	const rows: SkillRow[] = [];

	for (const dir of configStringList(doc, "skills", "customDirectories")) {
		const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
		for (const entry of entries) {
			if (!entry.isDirectory()) continue;
			const src = await readFile(join(dir, entry.name, "SKILL.md"), "utf8").catch(() => null);
			if (src === null) continue;
			rows.push({
				name: entry.name,
				description: frontmatterDescription(src),
				dir,
				enabled: !ignored.has(entry.name),
			});
		}
	}
	return rows.sort((a, b) => a.name.localeCompare(b.name));
}

async function setSkillEnabled(name: string, enabled: boolean): Promise<void> {
	// parseDocument (not parse) so comments and key order in config.yml survive.
	const doc = parseDocument((await readFile(CONFIG_YML, "utf8").catch(() => "")) || "{}");
	const ignored = new Set(configStringList(doc, "skills", "ignoredSkills"));
	if (enabled) ignored.delete(name);
	else ignored.add(name);
	doc.setIn(["skills", "ignoredSkills"], [...ignored].sort());
	await writeFile(CONFIG_YML, doc.toString(), "utf8");
}

/** Removes the skill's directory from disk, not just config - this is a
 *  delete, not a hide. Also drops any stale `ignoredSkills` entry left
 *  pointing at a name that no longer exists. */
async function deleteSkill(name: string): Promise<void> {
	const skill = (await listSkills()).find((s) => s.name === name);
	if (!skill) throw new Error(`unknown skill ${name}`);
	await rm(join(skill.dir, skill.name), { recursive: true, force: true });

	const doc = parseDocument((await readFile(CONFIG_YML, "utf8").catch(() => "")) || "{}");
	const ignored = new Set(configStringList(doc, "skills", "ignoredSkills"));
	if (ignored.delete(name)) {
		doc.setIn(["skills", "ignoredSkills"], [...ignored].sort());
		await writeFile(CONFIG_YML, doc.toString(), "utf8");
	}
}

// ---------------------------------------------------------------------- mcp

/**
 * Every config omp discovers MCP servers from, in omp's precedence order.
 * The first definition of a name wins; later ones are shadowed, not merged.
 * `key` is the property holding the server map in that file's shape.
 */
const MCP_SOURCES: { label: string; path: string; key: string; toml?: true }[] = [
	{ label: "omp", path: join(HOME, ".omp/agent/mcp.json"), key: "mcpServers" },
	{ label: "omp", path: join(HOME, ".omp/agent/.mcp.json"), key: "mcpServers" },
	{ label: "claude", path: join(HOME, ".claude.json"), key: "mcpServers" },
	{ label: "claude", path: join(HOME, ".claude/mcp.json"), key: "mcpServers" },
	{ label: "codex", path: join(HOME, ".codex/config.toml"), key: "mcp_servers", toml: true },
	{ label: "gemini", path: join(HOME, ".gemini/settings.json"), key: "mcpServers" },
	{ label: "cursor", path: join(HOME, ".cursor/mcp.json"), key: "mcpServers" },
	{ label: "opencode", path: join(HOME, ".config/opencode/opencode.json"), key: "mcp" },
];

async function readConfigFile(path: string, toml?: true): Promise<Record<string, unknown>> {
	const text = await readFile(path, "utf8").catch(() => "");
	if (!text.trim()) return {};
	try {
		return asRecord(toml ? Bun.TOML.parse(text) : JSON.parse(text)) ?? {};
	} catch {
		return {};
	}
}

/** The denylist omp applies across every source, in omp's own config. */
async function readDenylist(): Promise<string[]> {
	const cfg = await readConfigFile(MCP_JSON);
	return asStringList(cfg.disabledServers);
}

async function listMcp(): Promise<McpListing> {
	const disabled = new Set(await readDenylist());
	const byName = new Map<string, McpRow>();
	const sources: { label: string; path: string; count: number }[] = [];

	for (const src of MCP_SOURCES) {
		const cfg = await readConfigFile(src.path, src.toml);
		const servers = asRecord(cfg[src.key]);
		if (!servers) continue;
		const names = Object.keys(servers);
		if (names.length === 0) continue;
		sources.push({ label: src.label, path: src.path, count: names.length });

		for (const [name, value] of Object.entries(servers)) {
			// First definition wins; record later ones as shadowed instead.
			const existing = byName.get(name);
			if (existing) {
				if (!existing.shadowedBy.includes(src.label)) existing.shadowedBy.push(src.label);
				continue;
			}
			const entry = asRecord(value) ?? {};
			const url = typeof entry.url === "string" ? entry.url : undefined;
			const command = typeof entry.command === "string" ? entry.command : undefined;
			const target = url ?? [command, ...asStringList(entry.args)].filter(Boolean).join(" ");
			byName.set(name, {
				name,
				transport: typeof entry.type === "string" ? entry.type : url ? "http" : "stdio",
				target: target || "-",
				// disabledServers is the cross-source denylist; the entry's own
				// `enabled: false` is the weaker per-entry switch.
				enabled: !disabled.has(name) && entry.enabled !== false,
				disabledByList: disabled.has(name),
				source: src.label,
				shadowedBy: [],
			});
		}
	}

	return {
		rows: [...byName.values()].sort((a, b) => a.name.localeCompare(b.name)),
		denylistPath: MCP_JSON,
		sources,
	};
}

async function setMcpEnabled(name: string, enabled: boolean): Promise<void> {
	// Writes omp's own mcp.json even when the server is defined elsewhere:
	// disabledServers is a cross-source denylist keyed by name.
	const cfg = await readConfigFile(MCP_JSON);
	const disabled = new Set(asStringList(cfg.disabledServers));
	if (enabled) disabled.delete(name);
	else disabled.add(name);
	cfg.disabledServers = [...disabled].sort();
	await mkdir(dirname(MCP_JSON), { recursive: true });
	await writeFile(MCP_JSON, `${JSON.stringify(cfg, null, 2)}\n`, "utf8");
}

/**
 * Removes the server from every source file that defines it, not just the
 * highest-precedence one - deleting only the winning definition would let
 * a shadowed lower-precedence one quietly take its place afterward. JSON
 * sources round-trip through JSON.stringify like `setMcpEnabled` already
 * does; the one TOML source (codex) round-trips through Bun.TOML, which
 * does not preserve comments the way `yaml`'s parseDocument does for
 * config.yml, so a delete there may reformat the file.
 */
async function deleteMcp(name: string): Promise<void> {
	let found = false;
	for (const src of MCP_SOURCES) {
		const cfg = await readConfigFile(src.path, src.toml);
		const servers = asRecord(cfg[src.key]);
		if (!servers || !(name in servers)) continue;
		found = true;
		delete servers[name];
		const text = src.toml ? Bun.TOML.stringify(cfg) : `${JSON.stringify(cfg, null, 2)}\n`;
		await writeFile(src.path, text, "utf8");
	}
	if (!found) throw new Error(`${name} not found in any MCP config`);

	const denyCfg = await readConfigFile(MCP_JSON);
	const disabled = new Set(asStringList(denyCfg.disabledServers));
	if (disabled.delete(name)) {
		denyCfg.disabledServers = [...disabled].sort();
		await mkdir(dirname(MCP_JSON), { recursive: true });
		await writeFile(MCP_JSON, `${JSON.stringify(denyCfg, null, 2)}\n`, "utf8");
	}
}

// ------------------------------------------------------------------ routes

const server = Bun.serve({
	port: PORT,
	hostname: "127.0.0.1",
	idleTimeout: 30,
	async fetch(req) {
		const path = new URL(req.url).pathname;

		try {
			if (path === "/" || path === "/index.html") {
				return new Response(Bun.file(join(import.meta.dir, "index.html")));
			}

			if (path === "/api/ports") return json(await listPorts());

			if (path === "/api/ports/kill" && req.method === "POST") {
				const body = asRecord(await req.json()) ?? {};
				const pid = Number(body.pid);
				if (!Number.isFinite(pid)) return json({ error: "pid required" }, 400);
				if (pid === process.pid) return json({ error: "refusing to kill the panel itself" }, 400);
				const result = await killProcess(pid);
				return result.alive
					? json({ error: `pid ${pid} survived SIGKILL (${result.note})` }, 500)
					: json({ ok: true, signal: result.signal });
			}

			if (path === "/api/apps") return json(await listApps());

			if (path === "/api/apps/toggle" && req.method === "POST") {
				const body = asRecord(await req.json()) ?? {};
				if (typeof body.name !== "string" || typeof body.enabled !== "boolean") {
					return json({ error: "name and enabled required" }, 400);
				}
				await setAppRunning(body.name, body.enabled);
				return json({ ok: true });
			}

			if (path === "/api/agents") {
				if (req.method === "PUT") {
					await writeFile(AGENTS_MD, await req.text(), "utf8");
					return json({ ok: true });
				}
				return json({
					path: AGENTS_MD,
					content: await readFile(AGENTS_MD, "utf8").catch(() => ""),
				});
			}

			if (path === "/api/skills") return json(await listSkills());
			if (path === "/api/mcp") return json(await listMcp());

			if ((path === "/api/skills/toggle" || path === "/api/mcp/toggle") && req.method === "POST") {
				const body = asRecord(await req.json()) ?? {};
				if (typeof body.name !== "string" || typeof body.enabled !== "boolean") {
					return json({ error: "name and enabled required" }, 400);
				}
				if (path === "/api/skills/toggle") await setSkillEnabled(body.name, body.enabled);
				else await setMcpEnabled(body.name, body.enabled);
				return json({ ok: true });
			}

			if ((path === "/api/skills/delete" || path === "/api/mcp/delete") && req.method === "POST") {
				const body = asRecord(await req.json()) ?? {};
				if (typeof body.name !== "string") return json({ error: "name required" }, 400);
				if (path === "/api/skills/delete") await deleteSkill(body.name);
				else await deleteMcp(body.name);
				return json({ ok: true });
			}

			return new Response("not found", { status: 404 });
		} catch (err) {
			return json({ error: String(err) }, 500);
		}
	},
});

console.log(`omp-panel  http://127.0.0.1:${server.port}`);
