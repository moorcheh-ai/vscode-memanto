import * as vscode from "vscode";
import type { MemantoCore } from "../core";

/** Status bar entry: whether Memanto is reachable, and which agent is in use. */
export function createStatusItem(core: MemantoCore): vscode.StatusBarItem {
	const item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 90);
	item.command = "memanto.openChat";

	const update = (): void => {
		const agent = core.agentId;
		switch (core.status) {
			case "starting":
				item.text = "$(sync~spin) Memanto";
				item.tooltip = "Starting the Memanto server";
				break;
			case "checking":
				item.text = "$(sync~spin) Memanto";
				item.tooltip = "Looking for Memanto";
				break;
			case "online":
				item.text = `$(database) ${agent ?? "Memanto"}`;
				item.tooltip = new vscode.MarkdownString(
					`Memanto is running at \`${core.environment?.baseUrl ?? ""}\`${
						core.serverPid ? ` (pid ${core.serverPid})` : ""
					}.\n\nClick to open the chat.`,
				);
				break;
			case "offline":
				item.text = "$(debug-disconnect) Memanto";
				item.tooltip = core.lastServerError ?? "Memanto is not running. Click to set it up.";
				break;
			default:
				item.text = "$(database) Memanto";
				item.tooltip = "Click to open the Memanto chat";
		}
		item.backgroundColor = undefined;
		item.show();
	};

	core.onDidChangeStatus(update);
	core.onDidChangeAgent(update);
	update();
	return item;
}
