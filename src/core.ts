import { createHash } from "crypto";
import { unwatchFile, watchFile } from "fs";
import { join } from "path";
import * as vscode from "vscode";
import { MemantoClient } from "./api/client";
import {
	detect,
	needsSetup,
	readActiveAgentId,
	readSessionToken,
	sessionsDir,
	resolveBaseUrl,
	type Environment,
} from "./env/detect";
import { ServerManager, type ServerMode } from "./server/lifecycle";
import type { AgentInfo } from "./types";

export type ServerStatus = "idle" | "checking" | "starting" | "online" | "offline";

export interface MemantoSettings {
	serverMode: ServerMode;
	startOnStartup: boolean;
	address: string;
	recallLimit: number;
	citeOnInsert: boolean;
	memoriesPerType: number;
}

/**
 * Owns the connection to Memanto: detection, the server this window runs, the
 * API client, and the agent in use. Everything else in the extension reads this
 * and listens for changes.
 */
export class MemantoCore implements vscode.Disposable {
	readonly client: MemantoClient;
	environment: Environment | null = null;
	status: ServerStatus = "idle";
	/** Why the last start attempt failed, shown in the chat's offline state. */
	lastServerError: string | null = null;
	agents: AgentInfo[] = [];

	private readonly servers: ServerManager;
	private readonly output: vscode.OutputChannel;
	private readonly statusEmitter = new vscode.EventEmitter<ServerStatus>();
	private readonly agentEmitter = new vscode.EventEmitter<string>();
	private refreshing: Promise<Environment> | null = null;
	private refreshingAllowsStart = false;
	/** Last agent reported to listeners, so a switch elsewhere fires `onDidChangeAgent`. */
	private lastAgentId: string | null = null;
	private watchedMarker: string | null = null;

	readonly onDidChangeStatus = this.statusEmitter.event;
	readonly onDidChangeAgent = this.agentEmitter.event;

	constructor() {
		this.output = vscode.window.createOutputChannel("Memanto");

		this.client = new MemantoClient(() => ({
			baseUrl: this.environment?.baseUrl ?? resolveBaseUrl(this.settings.address),
			apiKey: this.environment?.apiKey ?? null,
			readSessionToken,
		}));

		this.servers = new ServerManager(
			(baseUrl) => this.probe(baseUrl),
			(message) => this.log(message),
			instanceKey(),
		);
	}

	get settings(): MemantoSettings {
		const config = vscode.workspace.getConfiguration("memanto");
		return {
			serverMode: config.get<ServerMode>("server.mode", "private"),
			startOnStartup: config.get<boolean>("server.startOnStartup", false),
			address: config.get<string>("server.address", ""),
			recallLimit: config.get<number>("recallLimit", 10),
			citeOnInsert: config.get<boolean>("citeOnInsert", true),
			memoriesPerType: config.get<number>("export.memoriesPerType", 200),
		};
	}

	get online(): boolean {
		return this.status === "online";
	}

	get serverPid(): number | null {
		return this.servers.pid;
	}

	/**
	 * The agent this window talks to: the agent active on this computer, shared
	 * with the CLI, coding tools and the desktop widget. Null when none is.
	 */
	get agentId(): string | null {
		return readActiveAgentId();
	}

	/**
	 * Fire `onDidChangeAgent` when the active agent changes outside this window
	 * (CLI, widget, another editor). Polls the marker file, because native file
	 * watchers miss symlink swaps on some platforms.
	 */
	private watchActiveAgent(): void {
		const marker = join(sessionsDir(), "active");
		if (marker === this.watchedMarker) return;
		if (this.watchedMarker) unwatchFile(this.watchedMarker);
		this.watchedMarker = marker;
		this.lastAgentId = this.agentId;
		watchFile(marker, { interval: 2000 }, () => this.notifyIfAgentChanged());
	}

	private notifyIfAgentChanged(): void {
		const current = this.agentId;
		if (current === this.lastAgentId) return;
		this.lastAgentId = current;
		void vscode.commands.executeCommand("setContext", "memanto.hasAgent", Boolean(current));
		if (current) this.agentEmitter.fire(current);
	}

	log(message: string): void {
		this.output.appendLine(`[${new Date().toISOString()}] ${message}`);
	}

	/**
	 * Bring the connection up if it is not already, and return whether it is.
	 *
	 * Called lazily by every command, so the server starts the first time Memanto
	 * is actually used rather than on every window that happens to open.
	 */
	async ensureOnline(): Promise<boolean> {
		if (this.online) return true;
		await this.refresh();
		return this.online;
	}

	/**
	 * Re-run detection and bring up the server this window talks to.
	 *
	 * Concurrent callers share one run, so two commands can never race two server
	 * starts against each other.
	 */
	refresh(): Promise<Environment> {
		return this.run(true);
	}

	/**
	 * Learn what is installed without starting anything.
	 *
	 * Used at startup so the status bar is honest from the first second, while
	 * the server still waits until Memanto is actually used.
	 */
	detectOnly(): Promise<Environment> {
		return this.run(false);
	}

	/**
	 * Share one run between concurrent callers, but never let a detect-only run
	 * satisfy a caller that wants the server started. Startup runs detection
	 * without starting anything, and the first command can easily arrive while
	 * that is still in flight; reusing it would report "not running" and never
	 * start.
	 */
	private run(allowStart: boolean): Promise<Environment> {
		if (this.refreshing && (this.refreshingAllowsStart || !allowStart)) return this.refreshing;

		const previous = this.refreshing ?? Promise.resolve(null);
		this.refreshingAllowsStart = allowStart;
		const next = previous
			.catch(() => null)
			.then(() => this.doRefresh(allowStart))
			.finally(() => {
				if (this.refreshing === next) {
					this.refreshing = null;
					this.refreshingAllowsStart = false;
				}
			});
		this.refreshing = next;
		return next;
	}

	private async doRefresh(allowStart: boolean): Promise<Environment> {
		this.setStatus("checking");
		const environment = await detect(this.settings.address, (url) => this.probe(url));
		this.environment = environment;

		if (this.settings.serverMode === "private") {
			// `detect` probed the address the CLI is configured for; in private
			// mode that server is deliberately ignored, so ours is the only answer.
			environment.serverUp = false;
			const owned = this.servers.baseUrl;

			if (owned && (await this.probe(owned))) {
				environment.serverUp = true;
				environment.baseUrl = owned;
				this.lastServerError = null;
			} else if (allowStart) {
				if (environment.binaryPath) this.setStatus("starting");
				const state = await this.servers.ensureDedicated(environment.binaryPath);
				if (state.running) {
					environment.serverUp = true;
					environment.baseUrl = state.baseUrl;
					this.lastServerError = null;
				} else {
					environment.baseUrl = "";
					this.lastServerError = environment.binaryPath ? state.message : null;
				}
			} else {
				environment.baseUrl = "";
			}
		} else {
			// Switching to "connect to my own server" retires the private one.
			this.servers.stop();
			this.lastServerError = null;
		}

		this.client.reset();
		await this.updateContextKeys(environment);
		this.setStatus(environment.serverUp ? "online" : "offline");

		this.watchActiveAgent();
		if (environment.serverUp) {
			// With auto-activate on, asking the server for the active agent
			// resumes the last one when none is active.
			if (!this.agentId) {
				await this.client.activeAgentId().catch(() => null);
				this.notifyIfAgentChanged();
			}
			void this.loadAgents();
		}
		return environment;
	}

	/** Stop the private server without shutting the extension down. */
	stopServer(): void {
		this.servers.stop();
		if (this.environment) this.environment.serverUp = false;
		this.setStatus("offline");
	}

	async loadAgents(): Promise<AgentInfo[]> {
		try {
			const list = await this.client.listAgents();
			this.agents = list.agents ?? [];
			await vscode.commands.executeCommand(
				"setContext",
				"memanto.hasAgent",
				Boolean(this.agentId),
			);
		} catch (error) {
			this.log(`Could not list agents: ${describe(error)}`);
		}
		return this.agents;
	}

	/**
	 * Make `agentId` the active agent on this computer, the same as
	 * `memanto agent activate`, so the CLI, coding tools and widget switch too.
	 */
	async setAgent(agentId: string): Promise<void> {
		await this.client.activateAgent(agentId);
		this.notifyIfAgentChanged();
	}

	/** True when the user still has real setup work in front of them. */
	get needsSetup(): boolean {
		return this.environment ? needsSetup(this.environment) : true;
	}

	private async updateContextKeys(environment: Environment): Promise<void> {
		await vscode.commands.executeCommand("setContext", "memanto.online", environment.serverUp);
		await vscode.commands.executeCommand(
			"setContext",
			"memanto.installed",
			Boolean(environment.binaryPath),
		);
		await vscode.commands.executeCommand(
			"setContext",
			"memanto.configured",
			environment.hasConfig && (environment.hasApiKey || environment.backend === "on-prem"),
		);
		await vscode.commands.executeCommand("setContext", "memanto.hasAgent", Boolean(this.agentId));
	}

	private setStatus(status: ServerStatus): void {
		this.status = status;
		this.statusEmitter.fire(status);
	}

	/** Liveness probe that never throws, shared by detection and the server manager. */
	private async probe(baseUrl: string): Promise<boolean> {
		if (!baseUrl) return false;
		return new MemantoClient(() => ({ baseUrl, apiKey: null })).isUp();
	}

	dispose(): void {
		// Stop the server we started. VS Code gives `deactivate` a short window,
		// so the kill is synchronous.
		this.servers.stop();
		if (this.watchedMarker) unwatchFile(this.watchedMarker);
		this.statusEmitter.dispose();
		this.agentEmitter.dispose();
		this.output.dispose();
	}
}

/**
 * Stable per-window key so two windows never share a private server.
 *
 * Keyed by workspace path where there is one, so a reopened window can reclaim
 * the server a crashed session left behind. A window with no folder falls back
 * to the session id, which is unique per window but does not survive a restart.
 */
function instanceKey(): string {
	const folder = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
	const identity = folder ?? `session:${vscode.env.sessionId}`;
	return createHash("sha1").update(identity).digest("hex").slice(0, 12);
}

export function describe(error: unknown): string {
	if (error instanceof Error) return error.message;
	return String(error);
}
