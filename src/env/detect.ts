import { existsSync, readFileSync } from "fs";
import { homedir } from "os";
import { delimiter, join } from "path";
import { load as parseYaml } from "js-yaml";

/**
 * Everything the extension can learn about the user's Memanto install without
 * asking them a single question.
 */
export interface Environment {
	/** A server answered `/health` at `baseUrl`. Only meaningful in attach mode. */
	serverUp: boolean;
	baseUrl: string;
	/** A Moorcheh API key was found in `~/.memanto/.env`. */
	hasApiKey: boolean;
	apiKey: string | null;
	/** `~/.memanto/config.yaml` exists and parsed. */
	hasConfig: boolean;
	/** Agent the CLI last activated, used as the default selection. */
	activeAgentId: string | null;
	/** `cloud` or `on-prem`, when the config says. */
	backend: string | null;
	/** Absolute path to the `memanto` executable, when one is on PATH. */
	binaryPath: string | null;
}

export const DEFAULT_PORT = 8000;

/** Where the CLI keeps its state. */
export function memantoHome(): string {
	return join(homedir(), ".memanto");
}

/**
 * Read the Moorcheh API key.
 *
 * The CLI keeps it in `~/.memanto/.env` and loads it with dotenv at run time, so
 * it is generally *not* in the environment the editor inherits. Read the file
 * first and treat the environment as a fallback for anyone exporting it
 * themselves. A local server also grants management access to loopback callers
 * with no key at all, so null here is not necessarily a problem.
 */
export function readApiKey(): string | null {
	const fromEnvironment = process.env.MOORCHEH_API_KEY?.trim();
	if (fromEnvironment) return fromEnvironment;

	const path = join(memantoHome(), ".env");
	if (!existsSync(path)) return null;

	let contents: string;
	try {
		contents = readFileSync(path, "utf8");
	} catch {
		return null;
	}

	for (const line of contents.split(/\r?\n/)) {
		const trimmed = line.trim();
		if (!trimmed || trimmed.startsWith("#")) continue;

		const separator = trimmed.indexOf("=");
		if (separator === -1) continue;
		if (trimmed.slice(0, separator).trim() !== "MOORCHEH_API_KEY") continue;

		const value = trimmed
			.slice(separator + 1)
			.trim()
			.replace(/^["']|["']$/g, "");
		return value || null;
	}
	return null;
}

/** Agent ids the server accepts; anything else must never reach a file path. */
const SAFE_AGENT_ID = /^[A-Za-z0-9._-]+$/;

/** Leave a margin so we never hand the server a token that expires mid-request. */
const SESSION_EXPIRY_MARGIN_MS = 60_000;

/**
 * The live session token an agent already has, if any.
 *
 * Memanto keeps exactly one session per agent, in `~/.memanto/sessions/{agent}.json`,
 * and rejects any token whose session id no longer matches that file. Creating a
 * session from the editor would therefore sign out the CLI and every coding agent
 * using the same agent. Joining the existing session instead leaves them alone.
 */
export function readSessionToken(agentId: string): string | null {
	if (!SAFE_AGENT_ID.test(agentId)) return null;

	const path = join(memantoHome(), "sessions", `${agentId}.json`);
	if (!existsSync(path)) return null;

	try {
		const session = JSON.parse(readFileSync(path, "utf8")) as {
			session_token?: unknown;
			status?: unknown;
			expires_at?: unknown;
		};
		if (typeof session.session_token !== "string" || !session.session_token) return null;
		if (session.status !== "active") return null;
		if (typeof session.expires_at === "string") {
			const expires = Date.parse(session.expires_at);
			if (Number.isFinite(expires) && expires - SESSION_EXPIRY_MARGIN_MS < Date.now()) return null;
		}
		return session.session_token;
	} catch {
		return null;
	}
}

interface MemantoConfig {
	port: number | null;
	url: string | null;
	activeAgentId: string | null;
	backend: string | null;
}

/**
 * Read `~/.memanto/config.yaml`.
 *
 * The file nests everything under a `memanto:` root, but tolerate a flat file
 * too, so a hand-edited config does not break detection.
 */
function readConfig(): MemantoConfig {
	const empty: MemantoConfig = { port: null, url: null, activeAgentId: null, backend: null };
	const path = join(memantoHome(), "config.yaml");
	if (!existsSync(path)) return empty;

	let parsed: Record<string, unknown>;
	try {
		parsed = (parseYaml(readFileSync(path, "utf8")) ?? {}) as Record<string, unknown>;
	} catch {
		return empty;
	}

	const root = (parsed.memanto ?? parsed) as Record<string, unknown>;
	const server = (root.server ?? {}) as Record<string, unknown>;

	return {
		port: typeof server.port === "number" ? server.port : null,
		url: typeof server.url === "string" ? server.url : null,
		activeAgentId: typeof root.active_agent_id === "string" ? root.active_agent_id : null,
		backend: typeof root.backend === "string" ? root.backend : null,
	};
}

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "0.0.0.0", "[::1]", "::1"]);

/**
 * Turn whatever the config or the user supplied into `scheme://host:port`.
 *
 * The CLI stores host and port as separate keys (`server.url: 127.0.0.1`,
 * `server.port: 8000`), so the port must be merged back in. Using `url` alone
 * yields `http://127.0.0.1`, which is port 80, where nothing serves Memanto.
 * A remote host keeps its scheme's default port, since it may sit behind a
 * proxy, and `0.0.0.0` is a bind address rather than a destination.
 */
export function normalizeBaseUrl(raw: string, port: number | null): string {
	const fallback = `http://127.0.0.1:${port ?? DEFAULT_PORT}`;
	let value = raw.trim();
	if (!value) return fallback;
	// No manual trimming: URL drops any path when the origin is rebuilt below,
	// and stripping slashes first would turn a bare "http://" into a hostname.
	if (!/^https?:\/\//i.test(value)) value = `http://${value}`;

	let url: URL;
	try {
		url = new URL(value);
	} catch {
		return fallback;
	}
	if (!url.hostname) return fallback;

	const loopback = LOOPBACK_HOSTS.has(url.hostname);
	if (url.hostname === "0.0.0.0") url.hostname = "127.0.0.1";
	if (!url.port && loopback) url.port = String(port ?? DEFAULT_PORT);

	return `${url.protocol}//${url.host}`;
}

/** Resolve the address of a server the user runs themselves. */
export function resolveBaseUrl(override: string): string {
	const trimmed = override.trim();
	if (trimmed) return normalizeBaseUrl(trimmed, null);

	const config = readConfig();
	return normalizeBaseUrl(config.url ?? "127.0.0.1", config.port);
}

/**
 * Look for the `memanto` executable on PATH.
 *
 * The extension never installs it. This only decides whether we can offer to
 * start a server, or whether we show the setup steps instead.
 */
export function findBinary(): string | null {
	const path = process.env.PATH;
	if (!path) return null;

	const names =
		process.platform === "win32" ? ["memanto.exe", "memanto.cmd", "memanto.bat"] : ["memanto"];

	for (const dir of path.split(delimiter)) {
		if (!dir) continue;
		for (const name of names) {
			const candidate = join(dir, name);
			try {
				if (existsSync(candidate)) return candidate;
			} catch {
				// An unreadable PATH entry is not our problem; keep looking.
			}
		}
	}
	return null;
}

/** Run the whole ladder. Cheap enough to call on activation and on every retry. */
export async function detect(
	addressOverride: string,
	probe: (baseUrl: string) => Promise<boolean>,
): Promise<Environment> {
	const config = readConfig();
	const baseUrl = resolveBaseUrl(addressOverride);
	const apiKey = readApiKey();

	return {
		serverUp: await probe(baseUrl),
		baseUrl,
		hasApiKey: apiKey !== null,
		apiKey,
		hasConfig: existsSync(join(memantoHome(), "config.yaml")),
		activeAgentId: config.activeAgentId,
		backend: config.backend,
		binaryPath: findBinary(),
	};
}

/** True when the user still has real setup work in front of them. */
export function needsSetup(environment: Environment): boolean {
	if (environment.serverUp) return false;
	return !environment.binaryPath || !environment.hasConfig;
}
