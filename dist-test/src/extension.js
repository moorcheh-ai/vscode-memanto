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
exports.activate = activate;
exports.deactivate = deactivate;
const vscode = __importStar(require("vscode"));
const commands_1 = require("./commands");
const core_1 = require("./core");
const chatView_1 = require("./ui/chatView");
const memoriesTree_1 = require("./ui/memoriesTree");
const memoryDocument_1 = require("./ui/memoryDocument");
const status_1 = require("./ui/status");
let core = null;
const FIRST_RUN_KEY = "memanto.introShown";
function activate(context) {
    core = new core_1.MemantoCore();
    context.subscriptions.push(core);
    (0, memoryDocument_1.registerMemoryDocuments)(context);
    const chat = new chatView_1.ChatViewProvider(core, context.extensionUri);
    const tree = new memoriesTree_1.MemoriesTreeProvider(core);
    context.subscriptions.push(vscode.window.registerWebviewViewProvider(chatView_1.ChatViewProvider.viewType, chat, {
        // Keep the transcript when the user switches to another view.
        webviewOptions: { retainContextWhenHidden: true },
    }), vscode.window.registerTreeDataProvider("memanto.memories", tree), (0, status_1.createStatusItem)(core));
    (0, commands_1.registerCommands)(context, core, chat, tree);
    // Re-detect when the settings that decide where the server lives change.
    context.subscriptions.push(vscode.workspace.onDidChangeConfiguration((event) => {
        if (event.affectsConfiguration("memanto.server") ||
            event.affectsConfiguration("memanto.agentId")) {
            void core?.refresh();
        }
    }));
    void start(context, core);
}
/**
 * Nothing here blocks activation: detection touches the filesystem and may
 * start a process, so it runs after VS Code has finished starting up.
 */
async function start(context, instance) {
    if (instance.settings.startOnStartup) {
        await instance.refresh();
        return;
    }
    // Without starting anything, still learn enough for an honest status bar.
    await instance.detectOnly().catch(() => undefined);
    if (instance.needsSetup && !context.globalState.get(FIRST_RUN_KEY)) {
        await context.globalState.update(FIRST_RUN_KEY, true);
        const choice = await vscode.window.showInformationMessage("Memanto: install the CLI to search your agents' memory from here.", "Setup steps", "Not now");
        if (choice === "Setup steps")
            await vscode.commands.executeCommand("memanto.setup");
    }
}
function deactivate() {
    // Stop the server this window started. Synchronous on purpose: VS Code gives
    // deactivation a short window, and an async kill may never be scheduled.
    core?.dispose();
    core = null;
}
