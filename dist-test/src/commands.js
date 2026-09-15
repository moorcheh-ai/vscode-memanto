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
exports.registerCommands = registerCommands;
const child_process_1 = require("child_process");
const vscode = __importStar(require("vscode"));
const core_1 = require("./core");
const types_1 = require("./types");
const memoryDocument_1 = require("./ui/memoryDocument");
const setup_1 = require("./ui/setup");
function registerCommands(context, core, chat, tree) {
    const register = (id, run) => {
        context.subscriptions.push(vscode.commands.registerCommand(id, run));
    };
    register("memanto.openChat", () => chat.reveal());
    register("memanto.setup", () => (0, setup_1.showSetup)(core));
    register("memanto.openMemory", (memory) => (0, memoryDocument_1.openMemoryDocument)(memory));
    register("memanto.refresh", async () => {
        await core.refresh();
        tree.refresh();
    });
    register("memanto.startServer", async () => {
        const environment = await core.refresh();
        if (environment.serverUp) {
            void vscode.window.showInformationMessage(`Memanto is running at ${environment.baseUrl}${core.serverPid ? ` (pid ${core.serverPid})` : ""}.`);
        }
        else if (core.lastServerError) {
            void vscode.window.showErrorMessage(`Memanto: ${core.lastServerError}`);
        }
        else {
            void offerSetup(core, "Memanto is not installed yet.");
        }
    });
    register("memanto.stopServer", () => {
        if (core.serverPid === null) {
            void vscode.window.showInformationMessage("Memanto: this window is not running a server of its own.");
            return;
        }
        core.stopServer();
        void vscode.window.showInformationMessage("Memanto: stopped this window's server.");
    });
    register("memanto.selectAgent", async () => {
        if (!(await ensure(core)))
            return;
        const agents = await core.loadAgents();
        if (agents.length === 0) {
            void vscode.window.showWarningMessage("Memanto: no agents yet. Create one with `memanto agent create`.");
            return;
        }
        const picked = await vscode.window.showQuickPick(agents.map((agent) => ({
            label: agent.agent_id,
            description: typeof agent.memory_count === "number"
                ? `${agent.memory_count.toLocaleString()} memories`
                : "",
            detail: agent.description ?? undefined,
        })), { title: "Memanto: select agent", placeHolder: core.agentId ?? "" });
        if (picked)
            await core.setAgent(picked.label);
    });
    register("memanto.recall", async () => {
        if (!(await ensure(core)))
            return;
        const agentId = core.agentId;
        if (!agentId)
            return void vscode.commands.executeCommand("memanto.selectAgent");
        const query = await vscode.window.showInputBox({
            title: `Memanto: recall from ${agentId}`,
            placeHolder: "What are you looking for?",
        });
        if (!query)
            return;
        const memories = await withProgress("Recalling memories", async () => {
            const response = await core.client.recall(agentId, query, {
                limit: core.settings.recallLimit,
            });
            return response.memories;
        });
        if (!memories)
            return;
        if (memories.length === 0) {
            void vscode.window.showInformationMessage("Memanto: nothing matched.");
            return;
        }
        const picked = await vscode.window.showQuickPick(memories.map((memory) => ({
            label: (0, types_1.memoryLabel)(memory),
            description: [
                memory.type,
                memory.confidence !== undefined ? `${Math.round(memory.confidence * 100)}%` : null,
            ]
                .filter(Boolean)
                .join(" · "),
            detail: (0, types_1.memoryText)(memory).replace(/\s+/g, " ").slice(0, 200),
            memory,
        })), { title: `${memories.length} memories`, matchOnDetail: true });
        if (picked)
            await (0, memoryDocument_1.openMemoryDocument)(picked.memory);
    });
    register("memanto.answer", async () => {
        if (!(await ensure(core)))
            return;
        const agentId = core.agentId;
        if (!agentId)
            return void vscode.commands.executeCommand("memanto.selectAgent");
        const question = await vscode.window.showInputBox({
            title: `Memanto: ask ${agentId}`,
            placeHolder: "What do you want to know?",
        });
        if (!question)
            return;
        const response = await withProgress("Thinking", () => core.client.answer(agentId, question));
        if (!response)
            return;
        const sources = (response.sources ?? [])
            .map((source) => `- ${(0, types_1.memoryLabel)(source)}`)
            .join("\n");
        const document = await vscode.workspace.openTextDocument({
            language: "markdown",
            content: `# ${question}\n\n${response.answer ?? ""}\n` +
                (sources ? `\n## Sources\n\n${sources}\n` : ""),
        });
        await vscode.window.showTextDocument(document, { preview: true });
    });
    register("memanto.rememberSelection", async () => {
        const editor = vscode.window.activeTextEditor;
        const selected = editor?.document.getText(editor.selection).trim();
        if (!editor || !selected) {
            void vscode.window.showWarningMessage("Memanto: select some text first.");
            return;
        }
        if (!(await ensure(core)))
            return;
        const agentId = core.agentId;
        if (!agentId)
            return void vscode.commands.executeCommand("memanto.selectAgent");
        const type = await vscode.window.showQuickPick([...types_1.MEMORY_TYPES], {
            title: "Memanto: remember as",
            placeHolder: "Pick a memory type",
        });
        if (!type)
            return;
        const where = vscode.workspace.asRelativePath(editor.document.uri);
        const saved = await withProgress("Saving memory", () => core.client.remember(agentId, selected, {
            type,
            source: "vscode",
            provenance: "explicit_statement",
            confidence: 1,
            tags: ["vscode"],
            title: `${type} from ${where}`,
        }));
        if (saved) {
            void vscode.window.showInformationMessage(`Memanto: remembered as ${type}.`);
            tree.refresh();
        }
    });
    register("memanto.exportMemories", async () => {
        const environment = core.environment ?? (await core.refresh());
        const agentId = core.agentId;
        if (!agentId)
            return void vscode.commands.executeCommand("memanto.selectAgent");
        if (!environment.binaryPath) {
            void offerSetup(core, "Memanto: the CLI is needed to export memories.");
            return;
        }
        const folders = await vscode.window.showOpenDialog({
            title: "Export Memanto memories into",
            canSelectFolders: true,
            canSelectFiles: false,
            openLabel: "Export here",
            defaultUri: vscode.workspace.workspaceFolders?.[0]?.uri,
        });
        const target = folders?.[0];
        if (!target)
            return;
        const done = await withProgress(`Exporting ${agentId}`, async () => {
            await runCli(environment.binaryPath, [
                "memory",
                "sync",
                "--okf",
                "--project-dir",
                target.fsPath,
                "--agent",
                agentId,
                "--limit",
                String(core.settings.memoriesPerType),
            ]);
            return true;
        });
        if (done) {
            const open = await vscode.window.showInformationMessage(`Memanto: exported ${agentId} to ${vscode.workspace.asRelativePath(target)}/okf.`, "Reveal");
            if (open) {
                await vscode.commands.executeCommand("revealFileInOS", vscode.Uri.joinPath(target, "okf"));
            }
        }
    });
}
/** Bring the connection up, and explain it if that fails. */
async function ensure(core) {
    if (await core.ensureOnline())
        return true;
    const message = core.lastServerError
        ? `Memanto: ${core.lastServerError}`
        : "Memanto is not set up in this window yet.";
    await offerSetup(core, message);
    return false;
}
async function offerSetup(core, message) {
    const choice = await vscode.window.showWarningMessage(message, "Setup steps");
    if (choice)
        await (0, setup_1.showSetup)(core);
}
/** Run work behind a notification, turning failures into a message. */
async function withProgress(title, work) {
    try {
        return await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: `Memanto: ${title}` }, work);
    }
    catch (error) {
        void vscode.window.showErrorMessage(`Memanto: ${(0, core_1.describe)(error)}`);
        return undefined;
    }
}
function runCli(binaryPath, args) {
    return new Promise((resolve, reject) => {
        // Node refuses to run .cmd/.bat without a shell (CVE-2024-27980).
        const needsShell = /\.(cmd|bat)$/i.test(binaryPath);
        (0, child_process_1.execFile)(needsShell ? `"${binaryPath}"` : binaryPath, args, {
            timeout: 300_000,
            windowsHide: true,
            maxBuffer: 8 * 1024 * 1024,
            shell: needsShell,
            // Without a console, Python on Windows falls back to the ANSI code
            // page and crashes printing the CLI's unicode output.
            env: { ...process.env, PYTHONIOENCODING: "utf-8", PYTHONUTF8: "1", NO_COLOR: "1" },
        }, (error, stdout, stderr) => {
            if (error)
                reject(new Error(stderr?.toString().trim() || error.message));
            else
                resolve(stdout?.toString() ?? "");
        });
    });
}
