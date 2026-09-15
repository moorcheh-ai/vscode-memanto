import type {
	AgentList,
	AnswerResponse,
	MemoryItem,
	RecallResponse,
	RememberResponse,
	Session,
	TemporalRecallResponse,
} from "../types";

/** Raised for every non-2xx response, so "the server said no" stays distinct
 * from "the server is not there" — they need different empty states. */
export class MemantoApiError extends Error {
	constructor(
		readonly status: number,
		message: string,
	) {
		super(message);
		this.name = "MemantoApiError";
	}
}

/** The server is unreachable, which almost always means it is not running. */
export class MemantoOfflineError extends Error {
	constructor(readonly baseUrl: string) {
		super(`No Memanto server is responding at ${baseUrl}`);
		this.name = "MemantoOfflineError";
	}
}

export interface ClientConfig {
	baseUrl: string;
	/** Read from the Memanto CLI at call time, never persisted by this extension. */
	apiKey: string | null;
	/** The agent's existing live session token, from Memanto's session files. */
	readSessionToken?: (agentId: string) => string | null;
}

export interface RecallOptions {
	limit?: number;
	types?: string[];
	tags?: string[];
	status?: "all" | "active" | "expired";
}

export interface RememberOptions {
	type?: string;
	title?: string;
	confidence?: number;
	tags?: string[];
	source?: string;
	provenance?: string;
}

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
export class MemantoClient {
	private sessions = new Map<string, string>();

	constructor(private readonly getConfig: () => ClientConfig) {}

	/** Drop cached sessions. Call when the address or key changes. */
	reset(): void {
		this.sessions.clear();
	}

	private get baseUrl(): string {
		return this.getConfig().baseUrl.replace(/\/+$/, "");
	}

	private async request(
		method: string,
		path: string,
		options: { body?: unknown; headers?: Record<string, string>; timeoutMs?: number } = {},
	): Promise<Response> {
		let response: Response;
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
		} catch {
			throw new MemantoOfflineError(this.baseUrl);
		}

		if (response.ok) return response;
		throw new MemantoApiError(response.status, await describeError(response));
	}

	/**
	 * Headers for agent-management calls.
	 *
	 * The key is optional on purpose: a Memanto server grants management access
	 * to loopback callers without one, which is the normal case here. Sending it
	 * when we have it keeps a non-loopback address working too.
	 */
	private managementHeaders(): Record<string, string> {
		const key = this.getConfig().apiKey;
		return key ? { "X-Api-Key": key } : {};
	}

	/** Cheapest possible liveness probe, used for attach-or-start decisions. */
	async isUp(): Promise<boolean> {
		try {
			await this.request("GET", "/health", { timeoutMs: PROBE_TIMEOUT_MS });
			return true;
		} catch (error) {
			return error instanceof MemantoApiError;
		}
	}

	async listAgents(): Promise<AgentList> {
		const response = await this.request("GET", "/api/v2/agents", {
			headers: this.managementHeaders(),
			timeoutMs: 15_000,
		});
		return (await response.json()) as AgentList;
	}

	private async activate(agentId: string): Promise<string> {
		const response = await this.request(
			"POST",
			`/api/v2/agents/${encodeURIComponent(agentId)}/activate`,
			{ headers: this.managementHeaders(), timeoutMs: 15_000 },
		);
		const session = (await response.json()) as Session;
		this.sessions.set(agentId, session.session_token);
		return session.session_token;
	}

	private existingSession(agentId: string): string | null {
		const token = this.getConfig().readSessionToken?.(agentId) ?? null;
		if (token) this.sessions.set(agentId, token);
		return token;
	}

	private async sessionToken(agentId: string): Promise<string> {
		return (
			this.sessions.get(agentId) ?? this.existingSession(agentId) ?? (await this.activate(agentId))
		);
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
	private async sessionCall<T>(agentId: string, path: string, body: unknown): Promise<T> {
		const send = (token: string): Promise<Response> =>
			this.request("POST", `/api/v2/agents/${encodeURIComponent(agentId)}${path}`, {
				body,
				headers: { "X-Session-Token": token },
			});

		let response: Response;
		const token = await this.sessionToken(agentId);
		try {
			response = await send(token);
		} catch (error) {
			if (!(error instanceof MemantoApiError) || error.status !== 401) throw error;
			this.sessions.delete(agentId);
			const rotated = this.existingSession(agentId);
			response = await send(rotated && rotated !== token ? rotated : await this.activate(agentId));
		}

		const renewed = response.headers.get("x-session-token");
		if (renewed) this.sessions.set(agentId, renewed);
		return (await response.json()) as T;
	}

	recall(agentId: string, query: string, options: RecallOptions = {}): Promise<RecallResponse> {
		return this.sessionCall<RecallResponse>(agentId, "/recall", {
			query,
			limit: options.limit,
			type: options.types?.length ? options.types : undefined,
			tags: options.tags?.length ? options.tags : undefined,
			status: options.status ?? "all",
		});
	}

	recallRecent(agentId: string, options: RecallOptions = {}): Promise<TemporalRecallResponse> {
		return this.sessionCall<TemporalRecallResponse>(agentId, "/recall/recent", {
			limit: options.limit,
			type: options.types?.length ? options.types : undefined,
			status: options.status ?? "all",
		});
	}

	/** `asOf` is `YYYY-MM-DD` or a full ISO 8601 timestamp. */
	recallAsOf(
		agentId: string,
		asOf: string,
		options: RecallOptions = {},
	): Promise<TemporalRecallResponse> {
		return this.sessionCall<TemporalRecallResponse>(agentId, "/recall/as-of", {
			as_of: asOf,
			limit: options.limit,
			type: options.types?.length ? options.types : undefined,
		});
	}

	recallChangedSince(
		agentId: string,
		since: string,
		options: RecallOptions = {},
	): Promise<TemporalRecallResponse> {
		return this.sessionCall<TemporalRecallResponse>(agentId, "/recall/changed-since", {
			since,
			limit: options.limit,
			type: options.types?.length ? options.types : undefined,
			status: options.status ?? "all",
		});
	}

	answer(agentId: string, question: string, limit?: number): Promise<AnswerResponse> {
		return this.sessionCall<AnswerResponse>(agentId, "/answer", { question, limit });
	}

	remember(
		agentId: string,
		content: string,
		options: RememberOptions = {},
	): Promise<RememberResponse> {
		return this.sessionCall<RememberResponse>(agentId, "/remember", {
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

/** Sources returned by `answer` are memories, so reuse the same shape. */
export type AnswerSources = MemoryItem[];

/** Pull the most useful message out of a FastAPI error body. */
async function describeError(response: Response): Promise<string> {
	let detail: unknown;
	try {
		detail = ((await response.json()) as { detail?: unknown } | null)?.detail;
	} catch {
		detail = undefined;
	}

	if (typeof detail === "string") return detail;
	if (Array.isArray(detail) && detail.length > 0) {
		const first = detail[0] as { msg?: string };
		if (first?.msg) return first.msg;
	}
	if (response.status === 401) {
		return "Memanto refused the request. Run `memanto config show` to check the API key it has stored.";
	}
	if (response.status === 404) return "Not found. The agent may have been deleted.";
	return `Memanto returned HTTP ${response.status}.`;
}
