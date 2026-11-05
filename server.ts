// omp-panel: local control panel for listening ports, AGENTS.md, skills and MCP servers.
// Binds loopback only. Every mutation writes the same files omp itself reads.
import { $ } from "bun";
import { Document, parse, parseDocument } from "yaml";
import { homedir } from "node:os";
import { join } from "node:path";
import { readdir, readFile, writeFile, stat } from "node:fs/promises";

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
}

export interface McpListing {
	rows: McpRow[];
	exists: boolean;
	path: string;
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

/**
 * Listening TCP sockets only: `-sTCP:LISTEN` keeps the list to servers rather
 * than every transient client connection.
 */
async function listPorts(): Promise<PortRow[]> {
	const out = await $`lsof -nP -iTCP -sTCP:LISTEN`.nothrow().text();
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

		rows.push({
			port,
			pid,
			command: f[0] ?? "?",
			address,
			argv: (await $`ps -p ${pid} -o command=`.nothrow().text()).trim(),
			self: pid === process.pid,
		});
	}
	return rows.sort((a, b) => a.port - b.port);
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

async function readMcpConfig(): Promise<Record<string, unknown>> {
	const text = await readFile(MCP_JSON, "utf8").catch(() => "");
	if (!text.trim()) return {};
	try {
		return asRecord(JSON.parse(text)) ?? {};
	} catch {
		return {};
	}
}

async function listMcp(): Promise<McpListing> {
	const cfg = await readMcpConfig();
	const exists = await stat(MCP_JSON).then(
		() => true,
		() => false,
	);
	const servers = asRecord(cfg.mcpServers) ?? {};
	const disabled = new Set(asStringList(cfg.disabledServers));

	const rows = Object.entries(servers).map(([name, value]): McpRow => {
		const entry = asRecord(value) ?? {};
		const url = typeof entry.url === "string" ? entry.url : undefined;
		const command = typeof entry.command === "string" ? entry.command : undefined;
		const target = url ?? [command, ...asStringList(entry.args)].filter(Boolean).join(" ");
		return {
			name,
			transport: typeof entry.type === "string" ? entry.type : url ? "http" : "stdio",
			target: target || "-",
			// disabledServers is the highest-precedence denylist; the entry's own
			// `enabled: false` is the weaker per-entry switch.
			enabled: !disabled.has(name) && entry.enabled !== false,
			disabledByList: disabled.has(name),
		};
	});

	return { rows: rows.sort((a, b) => a.name.localeCompare(b.name)), exists, path: MCP_JSON };
}

async function setMcpEnabled(name: string, enabled: boolean): Promise<void> {
	const cfg = await readMcpConfig();
	const disabled = new Set(asStringList(cfg.disabledServers));
	if (enabled) disabled.delete(name);
	else disabled.add(name);
	cfg.disabledServers = [...disabled].sort();
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
				await $`kill ${body.force === true ? "-9" : "-15"} ${pid}`.nothrow().quiet();
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
