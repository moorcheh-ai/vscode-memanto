"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.DEFAULT_PORT = void 0;
exports.memantoHome = memantoHome;
exports.readApiKey = readApiKey;
exports.readSessionToken = readSessionToken;
exports.normalizeBaseUrl = normalizeBaseUrl;
exports.resolveBaseUrl = resolveBaseUrl;
exports.findBinary = findBinary;
exports.detect = detect;
exports.needsSetup = needsSetup;
const fs_1 = require("fs");
const os_1 = require("os");
const path_1 = require("path");
const js_yaml_1 = require("js-yaml");
exports.DEFAULT_PORT = 8000;
/** Where the CLI keeps its state. */
function memantoHome() {
    return (0, path_1.join)((0, os_1.homedir)(), ".memanto");
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
function readApiKey() {
    const fromEnvironment = process.env.MOORCHEH_API_KEY?.trim();
    if (fromEnvironment)
        return fromEnvironment;
    const path = (0, path_1.join)(memantoHome(), ".env");
    if (!(0, fs_1.existsSync)(path))
        return null;
    let contents;
    try {
        contents = (0, fs_1.readFileSync)(path, "utf8");
    }
    catch {
        return null;
    }
    for (const line of contents.split(/\r?\n/)) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith("#"))
            continue;
        const separator = trimmed.indexOf("=");
        if (separator === -1)
            continue;
        if (trimmed.slice(0, separator).trim() !== "MOORCHEH_API_KEY")
            continue;
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
function readSessionToken(agentId) {
    if (!SAFE_AGENT_ID.test(agentId))
        return null;
    const path = (0, path_1.join)(memantoHome(), "sessions", `${agentId}.json`);
    if (!(0, fs_1.existsSync)(path))
        return null;
    try {
        const session = JSON.parse((0, fs_1.readFileSync)(path, "utf8"));
        if (typeof session.session_token !== "string" || !session.session_token)
            return null;
        if (session.status !== "active")
            return null;
        if (typeof session.expires_at === "string") {
            const expires = Date.parse(session.expires_at);
            if (Number.isFinite(expires) && expires - SESSION_EXPIRY_MARGIN_MS < Date.now())
                return null;
        }
        return session.session_token;
    }
    catch {
        return null;
    }
}
/**
 * Read `~/.memanto/config.yaml`.
 *
 * The file nests everything under a `memanto:` root, but tolerate a flat file
 * too, so a hand-edited config does not break detection.
 */
function readConfig() {
    const empty = { port: null, url: null, activeAgentId: null, backend: null };
    const path = (0, path_1.join)(memantoHome(), "config.yaml");
    if (!(0, fs_1.existsSync)(path))
        return empty;
    let parsed;
    try {
        parsed = ((0, js_yaml_1.load)((0, fs_1.readFileSync)(path, "utf8")) ?? {});
    }
    catch {
        return empty;
    }
    const root = (parsed.memanto ?? parsed);
    const server = (root.server ?? {});
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
function normalizeBaseUrl(raw, port) {
    const fallback = `http://127.0.0.1:${port ?? exports.DEFAULT_PORT}`;
    let value = raw.trim();
    if (!value)
        return fallback;
    // No manual trimming: URL drops any path when the origin is rebuilt below,
    // and stripping slashes first would turn a bare "http://" into a hostname.
    if (!/^https?:\/\//i.test(value))
        value = `http://${value}`;
    let url;
    try {
        url = new URL(value);
    }
    catch {
        return fallback;
    }
    if (!url.hostname)
        return fallback;
    const loopback = LOOPBACK_HOSTS.has(url.hostname);
    if (url.hostname === "0.0.0.0")
        url.hostname = "127.0.0.1";
    if (!url.port && loopback)
        url.port = String(port ?? exports.DEFAULT_PORT);
    return `${url.protocol}//${url.host}`;
}
/** Resolve the address of a server the user runs themselves. */
function resolveBaseUrl(override) {
    const trimmed = override.trim();
    if (trimmed)
        return normalizeBaseUrl(trimmed, null);
    const config = readConfig();
    return normalizeBaseUrl(config.url ?? "127.0.0.1", config.port);
}
/**
 * Look for the `memanto` executable on PATH.
 *
 * The extension never installs it. This only decides whether we can offer to
 * start a server, or whether we show the setup steps instead.
 */
function findBinary() {
    const path = process.env.PATH;
    if (!path)
        return null;
    const names = process.platform === "win32" ? ["memanto.exe", "memanto.cmd", "memanto.bat"] : ["memanto"];
    for (const dir of path.split(path_1.delimiter)) {
        if (!dir)
            continue;
        for (const name of names) {
            const candidate = (0, path_1.join)(dir, name);
            try {
                if ((0, fs_1.existsSync)(candidate))
                    return candidate;
            }
            catch {
                // An unreadable PATH entry is not our problem; keep looking.
            }
        }
    }
    return null;
}
/** Run the whole ladder. Cheap enough to call on activation and on every retry. */
async function detect(addressOverride, probe) {
    const config = readConfig();
    const baseUrl = resolveBaseUrl(addressOverride);
    const apiKey = readApiKey();
    return {
        serverUp: await probe(baseUrl),
        baseUrl,
        hasApiKey: apiKey !== null,
        apiKey,
        hasConfig: (0, fs_1.existsSync)((0, path_1.join)(memantoHome(), "config.yaml")),
        activeAgentId: config.activeAgentId,
        backend: config.backend,
        binaryPath: findBinary(),
    };
}
/** True when the user still has real setup work in front of them. */
function needsSetup(environment) {
    if (environment.serverUp)
        return false;
    return !environment.binaryPath || !environment.hasConfig;
}
