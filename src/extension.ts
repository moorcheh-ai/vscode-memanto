import * as vscode from "vscode";
import { registerParticipant } from "./ai/participant";
import { registerTools, ANSWER_TOOL, RECALL_TOOL, REMEMBER_TOOL } from "./ai/tools";
import { registerCommands } from "./commands";
import { MemantoCore } from "./core";
import { ChatViewProvider } from "./ui/chatView";
import { MemoriesTreeProvider } from "./ui/memoriesTree";
import { registerMemoryDocuments } from "./ui/memoryDocument";
import { createStatusItem } from "./ui/status";

let core: MemantoCore | null = null;

const FIRST_RUN_KEY = "memanto.introShown";

/** What `activate` returns, so tests can assert what actually got registered. */
export interface MemantoExtensionApi {
	participantRegistered: boolean;
	toolNames: string[];
	/** Live view of the server this window owns, so tests can assert it stopped. */
	serverState(): { pid: number | null; baseUrl: string; status: string };
}

export function activate(context: vscode.ExtensionContext): MemantoExtensionApi {
	core = new MemantoCore();
	context.subscriptions.push(core);

	registerMemoryDocuments(context);

	const chat = new ChatViewProvider(core, context.extensionUri);
	const tree = new MemoriesTreeProvider(core);

	context.subscriptions.push(
		vscode.window.registerWebviewViewProvider(ChatViewProvider.viewType, chat, {
			// Keep the transcript when the user switches to another view.
			webviewOptions: { retainContextWhenHidden: true },
		}),
		vscode.window.registerTreeDataProvider("memanto.memories", tree),
		createStatusItem(core),
	);

	registerCommands(context, core, chat, tree);

	// Copilot surfaces. Both are guarded: on a VS Code without these APIs the
	// extension still activates with its own sidebar.
	const participant = registerParticipant(core, context);
	if (participant) context.subscriptions.push(participant);
	const tools = registerTools(core);
	context.subscriptions.push(...tools);
	core.log(
		`Chat participant: ${participant ? "registered" : "unavailable"}. Language model tools: ${
			tools.length ? tools.length : "unavailable"
		}.`,
	);

	// Re-detect when the settings that decide where the server lives change.
	context.subscriptions.push(
		vscode.workspace.onDidChangeConfiguration((event) => {
			if (
				event.affectsConfiguration("memanto.server") ||
				event.affectsConfiguration("memanto.agentId")
			) {
				void core?.refresh();
			}
		}),
	);

	void start(context, core);

	const instance = core;
	return {
		participantRegistered: participant !== null,
		toolNames: tools.length ? [RECALL_TOOL, ANSWER_TOOL, REMEMBER_TOOL] : [],
		serverState: () => ({
			pid: instance.serverPid,
			baseUrl: instance.environment?.baseUrl ?? "",
			status: instance.status,
		}),
	};
}

/**
 * Nothing here blocks activation: detection touches the filesystem and may
 * start a process, so it runs after VS Code has finished starting up.
 */
async function start(context: vscode.ExtensionContext, instance: MemantoCore): Promise<void> {
	if (instance.settings.startOnStartup) {
		await instance.refresh();
		return;
	}

	// Without starting anything, still learn enough for an honest status bar.
	await instance.detectOnly().catch(() => undefined);

	if (instance.needsSetup && !context.globalState.get<boolean>(FIRST_RUN_KEY)) {
		await context.globalState.update(FIRST_RUN_KEY, true);
		const choice = await vscode.window.showInformationMessage(
			"Memanto: install the CLI to search your agents' memory from here.",
			"Setup steps",
			"Not now",
		);
		if (choice === "Setup steps") await vscode.commands.executeCommand("memanto.setup");
	}
}

export function deactivate(): void {
	// Stop the server this window started. Synchronous on purpose: VS Code gives
	// deactivation a short window, and an async kill may never be scheduled.
	core?.dispose();
	core = null;
}
