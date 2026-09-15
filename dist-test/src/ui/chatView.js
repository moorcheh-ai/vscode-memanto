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
exports.ChatViewProvider = void 0;
exports.memoryPreview = memoryPreview;
const crypto_1 = require("crypto");
const vscode = __importStar(require("vscode"));
const client_1 = require("../api/client");
const core_1 = require("../core");
const types_1 = require("../types");
const memoryDocument_1 = require("./memoryDocument");
/**
 * The chat sidebar.
 *
 * The webview only renders and collects input; every network call, credential
 * and file access stays in the extension host, so the untrusted document never
 * sees a token.
 */
class ChatViewProvider {
    core;
    extensionUri;
    static viewType = "memanto.chat";
    view = null;
    constructor(core, extensionUri) {
        this.core = core;
        this.extensionUri = extensionUri;
        core.onDidChangeStatus(() => this.postState());
        core.onDidChangeAgent(() => this.postState());
    }
    reveal() {
        void vscode.commands.executeCommand("memanto.chat.focus");
    }
    resolveWebviewView(view) {
        this.view = view;
        view.webview.options = {
            enableScripts: true,
            localResourceRoots: [this.extensionUri],
        };
        // Keep the transcript when the user switches to another view.
        view.webview.html = this.html(view.webview);
        view.webview.onDidReceiveMessage((message) => void this.onMessage(message));
        view.onDidChangeVisibility(() => {
            if (view.visible)
                void this.core.ensureOnline();
        });
        void this.core.ensureOnline();
    }
    async onMessage(message) {
        switch (message.type) {
            case "ready":
                this.postState();
                return;
            case "ask":
                await this.ask(message);
                return;
            case "insert":
                await (0, memoryDocument_1.insertIntoEditor)(String(message.text ?? ""), message.memory, this.core.settings.citeOnInsert);
                return;
            case "copy":
                await vscode.env.clipboard.writeText(String(message.text ?? ""));
                return;
            case "open":
                await (0, memoryDocument_1.openMemoryDocument)(message.memory);
                return;
            case "run":
                await vscode.commands.executeCommand(String(message.command));
                return;
            default:
                return;
        }
    }
    async ask(message) {
        const agentId = this.core.agentId;
        if (!agentId) {
            this.post({ type: "reply", id: message.id, ok: false, error: "Choose an agent first." });
            return;
        }
        const options = { limit: this.core.settings.recallLimit, types: message.types };
        try {
            if (message.mode === "answer") {
                const response = await this.core.client.answer(agentId, message.text);
                this.post({
                    type: "reply",
                    id: message.id,
                    ok: true,
                    kind: "answer",
                    answer: response.answer ?? "",
                    sources: response.sources ?? [],
                });
                return;
            }
            let memories;
            switch (message.temporal) {
                case "recent":
                    memories = (await this.core.client.recallRecent(agentId, options)).memories;
                    break;
                case "as-of":
                    memories = (await this.core.client.recallAsOf(agentId, message.date, options)).memories;
                    break;
                case "changed-since":
                    memories = (await this.core.client.recallChangedSince(agentId, message.date, options))
                        .memories;
                    break;
                default:
                    memories = (await this.core.client.recall(agentId, message.text, options)).memories;
            }
            this.post({ type: "reply", id: message.id, ok: true, kind: "recall", memories });
        }
        catch (error) {
            if (error instanceof client_1.MemantoOfflineError)
                void this.core.refresh();
            this.post({ type: "reply", id: message.id, ok: false, error: (0, core_1.describe)(error) });
        }
    }
    postState() {
        const environment = this.core.environment;
        this.post({
            type: "state",
            status: this.core.status,
            agentId: this.core.agentId ?? "",
            agents: this.core.agents.map((agent) => ({
                id: agent.agent_id,
                count: agent.memory_count ?? null,
            })),
            installed: Boolean(environment?.binaryPath),
            mode: this.core.settings.serverMode,
            address: environment?.baseUrl ?? "",
            error: this.core.lastServerError,
        });
    }
    post(message) {
        void this.view?.webview.postMessage(message);
    }
    html(webview) {
        const nonce = (0, crypto_1.randomBytes)(16).toString("base64");
        const script = webview.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, "dist", "webview.js"));
        const style = webview.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, "media", "chat.css"));
        const csp = [
            "default-src 'none'",
            `img-src ${webview.cspSource} data:`,
            `style-src ${webview.cspSource}`,
            `font-src ${webview.cspSource}`,
            `script-src 'nonce-${nonce}'`,
        ].join("; ");
        return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="${csp}">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<link href="${style}" rel="stylesheet">
<title>Memanto</title>
</head>
<body>
<div id="root"></div>
<script nonce="${nonce}" src="${script}"></script>
</body>
</html>`;
    }
}
exports.ChatViewProvider = ChatViewProvider;
function memoryPreview(memory) {
    return (0, types_1.memoryText)(memory);
}
