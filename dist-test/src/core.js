"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.MemantoCore = void 0;
exports.describe = describe;
const crypto_1 = require("crypto");
const vscode = __importStar(require("vscode"));
const client_1 = require("./api/client");
const detect_1 = require("./env/detect");
const lifecycle_1 = require("./server/lifecycle");
/**
 * Owns the connection to Memanto: detection, the server this window runs, the
 * API client, and the agent in use. Everything else in the extension reads this
 * and listens for changes.
 */
class MemantoCore {
    client;
    environment = null;
    status = "idle";
    /** Why the last start attempt failed, shown in the chat's offline state. */
    lastServerError = null;
    agents = [];
    servers;
    output;
    statusEmitter = new vscode.EventEmitter();
    agentEmitter = new vscode.EventEmitter();
    refreshing = null;
    onDidChangeStatus = this.statusEmitter.event;
    onDidChangeAgent = this.agentEmitter.event;
    constructor() {
        this.output = vscode.window.createOutputChannel("Memanto");
        this.client = new client_1.MemantoClient(() => ({
            baseUrl: this.environment?.baseUrl ?? (0, detect_1.resolveBaseUrl)(this.settings.address),
            apiKey: this.environment?.apiKey ?? null,
            readSessionToken: detect_1.readSessionToken,
        }));
        this.servers = new lifecycle_1.ServerManager((baseUrl) => this.probe(baseUrl), (message) => this.log(message), instanceKey());
    }
    get settings() {
        const config = vscode.workspace.getConfiguration("memanto");
        return {
            agentId: config.get("agentId", ""),
            serverMode: config.get("server.mode", "private"),
            startOnStartup: config.get("server.startOnStartup", false),
            address: config.get("server.address", ""),
            recallLimit: config.get("recallLimit", 10),
            citeOnInsert: config.get("citeOnInsert", true),
            memoriesPerType: config.get("export.memoriesPerType", 200),
        };
    }
    get online() {
        return this.status === "online";
    }
    get serverPid() {
        return this.servers.pid;
    }
    /** The agent this window talks to, or null until one is known. */
    get agentId() {
        return this.settings.agentId || this.environment?.activeAgentId || null;
    }
    log(message) {
        this.output.appendLine(`[${new Date().toISOString()}] ${message}`);
    }
    /**
     * Bring the connection up if it is not already, and return whether it is.
     *
     * Called lazily by every command, so the server starts the first time Memanto
     * is actually used rather than on every window that happens to open.
     */
    async ensureOnline() {
        if (this.online)
            return true;
        await this.refresh();
        return this.online;
    }
    /**
     * Re-run detection and bring up the server this window talks to.
     *
     * Concurrent callers share one run, so two commands can never race two server
     * starts against each other.
     */
    refresh() {
        return this.run(true);
    }
    /**
     * Learn what is installed without starting anything.
     *
     * Used at startup so the status bar is honest from the first second, while
     * the server still waits until Memanto is actually used.
     */
    detectOnly() {
        return this.run(false);
    }
    run(allowStart) {
        if (!this.refreshing) {
            this.refreshing = this.doRefresh(allowStart).finally(() => {
                this.refreshing = null;
            });
        }
        return this.refreshing;
    }
    async doRefresh(allowStart) {
        this.setStatus("checking");
        const environment = await (0, detect_1.detect)(this.settings.address, (url) => this.probe(url));
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
            }
            else if (allowStart) {
                if (environment.binaryPath)
                    this.setStatus("starting");
                const state = await this.servers.ensureDedicated(environment.binaryPath);
                if (state.running) {
                    environment.serverUp = true;
                    environment.baseUrl = state.baseUrl;
                    this.lastServerError = null;
                }
                else {
                    environment.baseUrl = "";
                    this.lastServerError = environment.binaryPath ? state.message : null;
                }
            }
            else {
                environment.baseUrl = "";
            }
        }
        else {
            // Switching to "connect to my own server" retires the private one.
            this.servers.stop();
            this.lastServerError = null;
        }
        this.client.reset();
        await this.updateContextKeys(environment);
        this.setStatus(environment.serverUp ? "online" : "offline");
        if (environment.serverUp)
            void this.loadAgents();
        return environment;
    }
    /** Stop the private server without shutting the extension down. */
    stopServer() {
        this.servers.stop();
        if (this.environment)
            this.environment.serverUp = false;
        this.setStatus("offline");
    }
    async loadAgents() {
        try {
            const list = await this.client.listAgents();
            this.agents = list.agents ?? [];
            await vscode.commands.executeCommand("setContext", "memanto.hasAgent", Boolean(this.agentId));
        }
        catch (error) {
            this.log(`Could not list agents: ${describe(error)}`);
        }
        return this.agents;
    }
    async setAgent(agentId) {
        const target = vscode.workspace.workspaceFolders?.length
            ? vscode.ConfigurationTarget.Workspace
            : vscode.ConfigurationTarget.Global;
        await vscode.workspace.getConfiguration("memanto").update("agentId", agentId, target);
        await vscode.commands.executeCommand("setContext", "memanto.hasAgent", true);
        this.agentEmitter.fire(agentId);
    }
    /** True when the user still has real setup work in front of them. */
    get needsSetup() {
        return this.environment ? (0, detect_1.needsSetup)(this.environment) : true;
    }
    async updateContextKeys(environment) {
        await vscode.commands.executeCommand("setContext", "memanto.online", environment.serverUp);
        await vscode.commands.executeCommand("setContext", "memanto.installed", Boolean(environment.binaryPath));
        await vscode.commands.executeCommand("setContext", "memanto.configured", environment.hasConfig && (environment.hasApiKey || environment.backend === "on-prem"));
        await vscode.commands.executeCommand("setContext", "memanto.hasAgent", Boolean(this.agentId));
    }
    setStatus(status) {
        this.status = status;
        this.statusEmitter.fire(status);
    }
    /** Liveness probe that never throws, shared by detection and the server manager. */
    async probe(baseUrl) {
        if (!baseUrl)
            return false;
        return new client_1.MemantoClient(() => ({ baseUrl, apiKey: null })).isUp();
    }
    dispose() {
        // Stop the server we started. VS Code gives `deactivate` a short window,
        // so the kill is synchronous.
        this.servers.stop();
        this.statusEmitter.dispose();
        this.agentEmitter.dispose();
        this.output.dispose();
    }
}
exports.MemantoCore = MemantoCore;
/**
 * Stable per-window key so two windows never share a private server.
 *
 * Keyed by workspace path where there is one, so a reopened window can reclaim
 * the server a crashed session left behind. A window with no folder falls back
 * to the session id, which is unique per window but does not survive a restart.
 */
function instanceKey() {
    const folder = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    const identity = folder ?? `session:${vscode.env.sessionId}`;
    return (0, crypto_1.createHash)("sha1").update(identity).digest("hex").slice(0, 12);
}
function describe(error) {
    if (error instanceof Error)
        return error.message;
    return String(error);
}
