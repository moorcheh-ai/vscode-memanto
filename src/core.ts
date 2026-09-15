import { createHash } from "crypto";
import * as vscode from "vscode";
import { MemantoClient } from "./api/client";
import {
	detect,
	needsSetup,
	readSessionToken,
	resolveBaseUrl,
	type Environment,
} from "./env/detect";
import { ServerManager, type ServerMode } from "./server/lifecycle";
import type { AgentInfo } from "./types";

export type ServerStatus = "idle" | "checking" | "starting" | "online" | "offline";

export interface MemantoSettings {
	agentId: string;
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
			agentId: config.get<string>("agentId", ""),
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

	/** The agent this window talks to, or null until one is known. */
	get agentId(): string | null {
		return this.settings.agentId || this.environment?.activeAgentId || null;
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

	private run(allowStart: boolean): Promise<Environment> {
		if (!this.refreshing) {
			this.refreshing = this.doRefresh(allowStart).finally(() => {
				this.refreshing = null;
			});
		}
		return this.refreshing;
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

		if (environment.serverUp) void this.loadAgents();
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

	async setAgent(agentId: string): Promise<void> {
		const target = vscode.workspace.workspaceFolders?.length
			? vscode.ConfigurationTarget.Workspace
			: vscode.ConfigurationTarget.Global;
		await vscode.workspace.getConfiguration("memanto").update("agentId", agentId, target);
		await vscode.commands.executeCommand("setContext", "memanto.hasAgent", true);
		this.agentEmitter.fire(agentId);
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
