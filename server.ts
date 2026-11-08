// omp-panel: local control panel for listening ports, AGENTS.md, skills and MCP servers.
// Binds loopback only. Every mutation writes the same files omp itself reads.
import { $ } from "bun";
import { Document, parse, parseDocument } from "yaml";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";

const HOME = homedir();
const CONFIG_YML = join(HOME, ".omp/agent/config.yml");
const MCP_JSON = join(HOME, ".omp/agent/mcp.json");
const AGENTS_MD = join(HOME, ".agents/AGENTS.md");
const PORT = Number(process.env.OMP_PANEL_PORT ?? 8777);

export interface PortRow {
	port: number;
	pid: number;
	command: string;
	address: string;
	argv: string;
	self: boolean;
}

export interface AppRow {
	name: string;
	bundleId: string;
	path: string;
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

// -------------------------------------------------------------------- apps

/** Top-level folders Finder treats as app sources. Scanned one level deep,
 *  plus one more level into subfolders (e.g. `Utilities`) so grouped apps
 *  show up without walking into any app's own bundle contents. */
const APP_DIRS = [
	"/Applications",
	"/System/Applications",
	"/System/Applications/Utilities",
	join(HOME, "Applications"),
];

/** Every .app bundle directly under `dir`, or one level inside a non-bundle
 *  subfolder of it (covers things like an `/Applications/Utilities` or a
 *  vendor folder holding several apps). */
async function findApps(dir: string): Promise<string[]> {
	const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
	const found: string[] = [];
	for (const entry of entries) {
		if (!entry.isDirectory()) continue;
		if (entry.name.endsWith(".app")) {
			found.push(join(dir, entry.name));
			continue;
		}
		const nested = await readdir(join(dir, entry.name), { withFileTypes: true }).catch(() => []);
		for (const n of nested) {
			if (n.isDirectory() && n.name.endsWith(".app")) found.push(join(dir, entry.name, n.name));
		}
	}
	return found;
}

/** CFBundleIdentifier of a .app bundle, or undefined if it has none. */
async function appBundleId(appPath: string): Promise<string | undefined> {
	const out = await $`/usr/libexec/PlistBuddy -c "Print :CFBundleIdentifier" ${join(appPath, "Contents/Info.plist")}`
		.nothrow()
		.text();
	const id = out.trim();
	return id && !id.includes("Does Not Exist") ? id : undefined;
}

/**
 * Full command line of every running process. Matching app liveness against
 * this (rather than `tell application "System Events" to get ... processes`)
 * is deliberate: Apple Events need per-target-app Automation (TCC)
 * permission, which a backgrounded LaunchAgent has no way to be granted -
 * the request has nowhere to show its consent prompt, so it hangs instead
 * of failing. Plain `ps` needs no permission at all.
 */
async function listRunningCommands(): Promise<string[]> {
	const out = await $`ps -A -o command=`.nothrow().text();
	return out.split("\n");
}

/** True if some running process's executable lives inside this bundle. */
function isAppRunning(appPath: string, commands: string[]): boolean {
	const prefix = `${appPath}/Contents/MacOS/`;
	return commands.some((c) => c.startsWith(prefix));
}

async function listApps(): Promise<AppRow[]> {
	const [paths, commands] = await Promise.all([
		Promise.all(APP_DIRS.map(findApps)).then((lists) => lists.flat()),
		listRunningCommands(),
	]);
	const withIds = await Promise.all(paths.map(async (path) => ({ path, bundleId: await appBundleId(path) })));

	const seen = new Set<string>();
	const rows: AppRow[] = [];
	for (const { path, bundleId } of withIds) {
		if (!bundleId || seen.has(bundleId)) continue;
		seen.add(bundleId);
		rows.push({
			name: path.split("/").pop()!.replace(/\.app$/, ""),
			bundleId,
			path,
			running: isAppRunning(path, commands),
		});
	}
	return rows.sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * Open launches the app normally (`open -b`). Quit goes through
 * NSRunningApplication (via a one-line JXA script), not an AppleEvent
 * ("tell application ... to quit"): that still runs the app's normal
 * termination sequence - unsaved-document prompts included - but it's a
 * direct in-process Cocoa call rather than a cross-app Apple Event, so it
 * needs no Automation (TCC) permission either.
 */
async function setAppRunning(bundleId: string, running: boolean): Promise<void> {
	if (running) {
		const result = await $`open -b ${bundleId}`.nothrow();
		if (result.exitCode !== 0) throw new Error(`could not open ${bundleId}`);
		return;
	}
	const script = `ObjC.import("AppKit"); var apps = $.NSRunningApplication.runningApplicationsWithBundleIdentifier(${JSON.stringify(bundleId)}); var n = apps.count; for (var i = 0; i < n; i++) { apps.objectAtIndex(i).terminate; } n;`;
	await $`osascript -l JavaScript -e ${script}`.nothrow();
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

			return new Response("not found", { status: 404 });
		} catch (err) {
			return json({ error: String(err) }, 500);
		}
	},
});

console.log(`omp-panel  http://127.0.0.1:${server.port}`);
