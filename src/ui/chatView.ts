import { randomBytes } from "crypto";
import * as vscode from "vscode";
import { MemantoOfflineError } from "../api/client";
import { describe, type MemantoCore } from "../core";
import { memoryText, type MemoryItem } from "../types";
import { insertIntoEditor, openMemoryDocument } from "./memoryDocument";

type Temporal = "search" | "recent" | "as-of" | "changed-since";

interface AskMessage {
	type: "ask";
	id: number;
	mode: "recall" | "answer";
	text: string;
	temporal: Temporal;
	date: string;
	types: string[];
}

/**
 * The chat sidebar.
 *
 * The webview only renders and collects input; every network call, credential
 * and file access stays in the extension host, so the untrusted document never
 * sees a token.
 */
export class ChatViewProvider implements vscode.WebviewViewProvider {
	static readonly viewType = "memanto.chat";

	private view: vscode.WebviewView | null = null;

	constructor(
		private readonly core: MemantoCore,
		private readonly extensionUri: vscode.Uri,
	) {
		core.onDidChangeStatus(() => this.postState());
		core.onDidChangeAgent(() => this.postState());
	}

	reveal(): void {
		void vscode.commands.executeCommand("memanto.chat.focus");
	}

	resolveWebviewView(view: vscode.WebviewView): void {
		this.view = view;
		view.webview.options = {
			enableScripts: true,
			localResourceRoots: [this.extensionUri],
		};
		// Keep the transcript when the user switches to another view.
		view.webview.html = this.html(view.webview);

		view.webview.onDidReceiveMessage((message) => void this.onMessage(message));

		view.onDidChangeVisibility(() => {
			if (view.visible) void this.core.ensureOnline();
		});
		void this.core.ensureOnline();
	}

	private async onMessage(message: Record<string, unknown>): Promise<void> {
		switch (message.type) {
			case "ready":
				this.postState();
				return;
			case "ask":
				await this.ask(message as unknown as AskMessage);
				return;
			case "insert":
				await insertIntoEditor(
					String(message.text ?? ""),
					message.memory as MemoryItem | undefined,
					this.core.settings.citeOnInsert,
				);
				return;
			case "copy":
				await vscode.env.clipboard.writeText(String(message.text ?? ""));
				return;
			case "open":
				await openMemoryDocument(message.memory as MemoryItem);
				return;
			case "run":
				await vscode.commands.executeCommand(String(message.command));
				return;
			default:
				return;
		}
	}

	private async ask(message: AskMessage): Promise<void> {
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

			let memories: MemoryItem[];
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
		} catch (error) {
			if (error instanceof MemantoOfflineError) void this.core.refresh();
			this.post({ type: "reply", id: message.id, ok: false, error: describe(error) });
		}
	}

	private postState(): void {
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

	private post(message: Record<string, unknown>): void {
		void this.view?.webview.postMessage(message);
	}

	private html(webview: vscode.Webview): string {
		const nonce = randomBytes(16).toString("base64");
		const script = webview.asWebviewUri(
			vscode.Uri.joinPath(this.extensionUri, "dist", "webview.js"),
		);
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

export function memoryPreview(memory: MemoryItem): string {
	return memoryText(memory);
}
