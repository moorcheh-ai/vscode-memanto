import * as vscode from "vscode";
import { describe, type MemantoCore } from "../core";
import { MEMORY_TYPES, memoryLabel, memoryText, type MemoryItem } from "../types";

type Node =
	| { kind: "type"; type: string }
	| { kind: "memory"; memory: MemoryItem }
	| { kind: "message"; text: string };

/**
 * Browse the agent's memories by type.
 *
 * Types are listed up front and their memories are fetched only when a type is
 * expanded, so opening the view costs one request at most rather than thirteen.
 */
export class MemoriesTreeProvider implements vscode.TreeDataProvider<Node> {
	private readonly emitter = new vscode.EventEmitter<Node | undefined>();
	readonly onDidChangeTreeData = this.emitter.event;

	constructor(private readonly core: MemantoCore) {
		core.onDidChangeStatus(() => this.refresh());
		core.onDidChangeAgent(() => this.refresh());
	}

	refresh(): void {
		this.emitter.fire(undefined);
	}

	getTreeItem(node: Node): vscode.TreeItem {
		if (node.kind === "message") {
			return new vscode.TreeItem(node.text, vscode.TreeItemCollapsibleState.None);
		}

		if (node.kind === "type") {
			const item = new vscode.TreeItem(node.type, vscode.TreeItemCollapsibleState.Collapsed);
			item.iconPath = new vscode.ThemeIcon("symbol-enum-member");
			item.contextValue = "memantoType";
			return item;
		}

		const memory = node.memory;
		const item = new vscode.TreeItem(memoryLabel(memory), vscode.TreeItemCollapsibleState.None);
		item.description = [
			memory.confidence !== undefined ? `${Math.round(memory.confidence * 100)}%` : null,
			memory.created_at?.slice(0, 10) ?? null,
		]
			.filter(Boolean)
			.join(" · ");
		item.tooltip = new vscode.MarkdownString(
			`${memoryText(memory)}\n\n---\n\n${[
				memory.type && `**Type** ${memory.type}`,
				memory.provenance && `**Provenance** ${memory.provenance.replace(/_/g, " ")}`,
				memory.source && `**Source** ${memory.source}`,
				memory.status && `**Status** ${memory.status}`,
			]
				.filter(Boolean)
				.join("  \n")}`,
		);
		item.iconPath = new vscode.ThemeIcon(memory.status === "active" ? "circle-filled" : "circle");
		item.contextValue = "memantoMemory";
		item.command = {
			command: "memanto.openMemory",
			title: "Open memory",
			arguments: [memory],
		};
		return item;
	}

	async getChildren(node?: Node): Promise<Node[]> {
		if (!this.core.online || !this.core.agentId) return [];

		if (!node) return MEMORY_TYPES.map((type) => ({ kind: "type" as const, type }));
		if (node.kind !== "type") return [];

		try {
			const response = await this.core.client.recallRecent(this.core.agentId, {
				limit: 50,
				types: [node.type],
			});
			if (response.memories.length === 0) {
				return [{ kind: "message", text: "No memories of this type" }];
			}
			return response.memories.map((memory) => ({ kind: "memory" as const, memory }));
		} catch (error) {
			return [{ kind: "message", text: describe(error) }];
		}
	}
}
