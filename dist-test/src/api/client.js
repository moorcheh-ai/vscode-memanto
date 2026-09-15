"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.MemantoClient = exports.MemantoOfflineError = exports.MemantoApiError = void 0;
/** Raised for every non-2xx response, so "the server said no" stays distinct
 * from "the server is not there" — they need different empty states. */
class MemantoApiError extends Error {
    status;
    constructor(status, message) {
        super(message);
        this.status = status;
        this.name = "MemantoApiError";
    }
}
exports.MemantoApiError = MemantoApiError;
/** The server is unreachable, which almost always means it is not running. */
class MemantoOfflineError extends Error {
    baseUrl;
    constructor(baseUrl) {
        super(`No Memanto server is responding at ${baseUrl}`);
        this.baseUrl = baseUrl;
        this.name = "MemantoOfflineError";
    }
}
exports.MemantoOfflineError = MemantoOfflineError;
const REQUEST_TIMEOUT_MS = 120_000;
const PROBE_TIMEOUT_MS = 2_000;
/**
 * Thin client over the Memanto local REST API.
 *
 * Two credentials are in play and they are not interchangeable: agent
 * management (`GET /agents`, activation) takes `X-Api-Key`, while memory
 * operations take an `X-Session-Token`.
 *
 * Memanto allows one session per agent, and activating a new one invalidates
 * every token already issued for that agent — the CLI's, and those held by any
 * coding agent sharing it. So this client joins the agent's existing session
 * whenever there is a live one, and only activates when there is none.
 */
class MemantoClient {
    getConfig;
    sessions = new Map();
    constructor(getConfig) {
        this.getConfig = getConfig;
    }
    /** Drop cached sessions. Call when the address or key changes. */
    reset() {
        this.sessions.clear();
    }
    get baseUrl() {
        return this.getConfig().baseUrl.replace(/\/+$/, "");
    }
    async request(method, path, options = {}) {
        let response;
        try {
            response = await fetch(`${this.baseUrl}${path}`, {
                method,
                headers: {
                    Accept: "application/json",
                    ...(options.body === undefined ? {} : { "Content-Type": "application/json" }),
                    ...(options.headers ?? {}),
                },
                body: options.body === undefined ? undefined : JSON.stringify(options.body),
                signal: AbortSignal.timeout(options.timeoutMs ?? REQUEST_TIMEOUT_MS),
            });
        }
        catch {
            throw new MemantoOfflineError(this.baseUrl);
        }
        if (response.ok)
            return response;
        throw new MemantoApiError(response.status, await describeError(response));
    }
    /**
     * Headers for agent-management calls.
     *
     * The key is optional on purpose: a Memanto server grants management access
     * to loopback callers without one, which is the normal case here. Sending it
     * when we have it keeps a non-loopback address working too.
     */
    managementHeaders() {
        const key = this.getConfig().apiKey;
        return key ? { "X-Api-Key": key } : {};
    }
    /** Cheapest possible liveness probe, used for attach-or-start decisions. */
    async isUp() {
        try {
            await this.request("GET", "/health", { timeoutMs: PROBE_TIMEOUT_MS });
            return true;
        }
        catch (error) {
            return error instanceof MemantoApiError;
        }
    }
    async listAgents() {
        const response = await this.request("GET", "/api/v2/agents", {
            headers: this.managementHeaders(),
            timeoutMs: 15_000,
        });
        return (await response.json());
    }
    async activate(agentId) {
        const response = await this.request("POST", `/api/v2/agents/${encodeURIComponent(agentId)}/activate`, { headers: this.managementHeaders(), timeoutMs: 15_000 });
        const session = (await response.json());
        this.sessions.set(agentId, session.session_token);
        return session.session_token;
    }
    existingSession(agentId) {
        const token = this.getConfig().readSessionToken?.(agentId) ?? null;
        if (token)
            this.sessions.set(agentId, token);
        return token;
    }
    async sessionToken(agentId) {
        return (this.sessions.get(agentId) ?? this.existingSession(agentId) ?? (await this.activate(agentId)));
    }
    /**
     * Run a session-scoped call.
     *
     * On a 401 the token we held has been rotated, by auto-renewal or by another
     * client activating the same agent. Prefer picking up the new token from the
     * session file over activating another session, which would in turn sign that
     * other client out. The server may also return a renewed token in the
     * `X-Session-Token` response header, so adopt it when it does.
     */
    async sessionCall(agentId, path, body) {
        const send = (token) => this.request("POST", `/api/v2/agents/${encodeURIComponent(agentId)}${path}`, {
            body,
            headers: { "X-Session-Token": token },
        });
        let response;
        const token = await this.sessionToken(agentId);
        try {
            response = await send(token);
        }
        catch (error) {
            if (!(error instanceof MemantoApiError) || error.status !== 401)
                throw error;
            this.sessions.delete(agentId);
            const rotated = this.existingSession(agentId);
            response = await send(rotated && rotated !== token ? rotated : await this.activate(agentId));
        }
        const renewed = response.headers.get("x-session-token");
        if (renewed)
            this.sessions.set(agentId, renewed);
        return (await response.json());
    }
    recall(agentId, query, options = {}) {
        return this.sessionCall(agentId, "/recall", {
            query,
            limit: options.limit,
            type: options.types?.length ? options.types : undefined,
            tags: options.tags?.length ? options.tags : undefined,
            status: options.status ?? "all",
        });
    }
    recallRecent(agentId, options = {}) {
        return this.sessionCall(agentId, "/recall/recent", {
            limit: options.limit,
            type: options.types?.length ? options.types : undefined,
            status: options.status ?? "all",
        });
    }
    /** `asOf` is `YYYY-MM-DD` or a full ISO 8601 timestamp. */
    recallAsOf(agentId, asOf, options = {}) {
        return this.sessionCall(agentId, "/recall/as-of", {
            as_of: asOf,
            limit: options.limit,
            type: options.types?.length ? options.types : undefined,
        });
    }
    recallChangedSince(agentId, since, options = {}) {
        return this.sessionCall(agentId, "/recall/changed-since", {
            since,
            limit: options.limit,
            type: options.types?.length ? options.types : undefined,
            status: options.status ?? "all",
        });
    }
    answer(agentId, question, limit) {
        return this.sessionCall(agentId, "/answer", { question, limit });
    }
    remember(agentId, content, options = {}) {
        return this.sessionCall(agentId, "/remember", {
            content,
            type: options.type,
            title: options.title,
            confidence: options.confidence,
            tags: options.tags?.length ? options.tags : undefined,
            source: options.source,
            provenance: options.provenance,
        });
    }
}
exports.MemantoClient = MemantoClient;
/** Pull the most useful message out of a FastAPI error body. */
async function describeError(response) {
    let detail;
    try {
        detail = (await response.json())?.detail;
    }
    catch {
        detail = undefined;
    }
    if (typeof detail === "string")
        return detail;
    if (Array.isArray(detail) && detail.length > 0) {
        const first = detail[0];
        if (first?.msg)
            return first.msg;
    }
    if (response.status === 401) {
        return "Memanto refused the request. Run `memanto config show` to check the API key it has stored.";
    }
    if (response.status === 404)
        return "Not found. The agent may have been deleted.";
    return `Memanto returned HTTP ${response.status}.`;
}
