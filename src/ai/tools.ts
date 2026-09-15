import * as vscode from "vscode";
import { describe, type MemantoCore } from "../core";
import { memoryText, type MemoryItem } from "../types";

export const RECALL_TOOL = "memanto_recall";
export const REMEMBER_TOOL = "memanto_remember";

export interface RecallToolInput {
	query: string;
	type?: string;
	limit?: number;
}

export interface RememberToolInput {
	content: string;
	type?: string;
	title?: string;
}

/**
 * Tools the model may call on its own.
 *
 * Reading is safe to run unattended, so `memanto_recall` runs without asking.
 * Writing is not: `memanto_remember` asks for confirmation first, because a
 * model deciding by itself what is worth remembering would quietly fill the
 * estate with noise that every other agent then has to read.
 */
export function registerTools(core: MemantoCore): vscode.Disposable[] {
	if (typeof vscode.lm?.registerTool !== "function") return [];
	return [
		vscode.lm.registerTool(RECALL_TOOL, new RecallTool(core)),
		vscode.lm.registerTool(REMEMBER_TOOL, new RememberTool(core)),
	];
}

export class RecallTool implements vscode.LanguageModelTool<RecallToolInput> {
	constructor(private readonly core: MemantoCore) {}

	prepareInvocation(
		options: vscode.LanguageModelToolInvocationPrepareOptions<RecallToolInput>,
	): vscode.PreparedToolInvocation {
		const query = options.input?.query?.trim();
		return {
			invocationMessage: query
				? `Recalling “${query}” from ${this.core.agentId ?? "Memanto"}`
				: "Recalling from Memanto",
		};
	}

	async invoke(
		options: vscode.LanguageModelToolInvocationOptions<RecallToolInput>,
	): Promise<vscode.LanguageModelToolResult> {
		const ready = await this.ready();
		if (ready) return text(ready);

		const agentId = this.core.agentId as string;
		const input = options.input ?? ({} as RecallToolInput);
		const query = (input.query ?? "").trim();
		if (!query) return text("No query was given, so nothing was searched.");

		try {
			const response = await this.core.client.recall(agentId, query, {
				limit: clampLimit(input.limit, this.core.settings.recallLimit),
				types: input.type ? [input.type] : undefined,
			});
			return text(format(response.memories, query, agentId));
		} catch (error) {
			// Returning the problem as text lets the model carry on and say so,
			// rather than the whole request failing.
			return text(`Memanto could not be searched: ${describe(error)}`);
		}
	}

	/** Null when ready, otherwise the message to hand back to the model. */
	private async ready(): Promise<string | null> {
		if (!(await this.core.ensureOnline())) {
			return this.core.lastServerError
				? `Memanto is not running: ${this.core.lastServerError}`
				: "Memanto is not running in this window, so no memories are available.";
		}
		if (!this.core.agentId) return "No Memanto agent is selected in this window.";
		return null;
	}
}

export class RememberTool implements vscode.LanguageModelTool<RememberToolInput> {
	constructor(private readonly core: MemantoCore) {}

	prepareInvocation(
		options: vscode.LanguageModelToolInvocationPrepareOptions<RememberToolInput>,
	): vscode.PreparedToolInvocation {
		const input = options.input ?? ({} as RememberToolInput);
		const preview = (input.content ?? "").trim().slice(0, 300);
		return {
			invocationMessage: `Saving a memory to ${this.core.agentId ?? "Memanto"}`,
			// Writing is shared, durable state that every other agent will read,
			// so the user approves it rather than the model deciding alone.
			confirmationMessages: {
				title: `Remember this in ${this.core.agentId ?? "Memanto"}?`,
				message: new vscode.MarkdownString(
					`Save as **${input.type ?? "fact"}**:\n\n> ${preview || "(empty)"}\n\nEvery agent sharing this Memanto agent will be able to recall it.`,
				),
			},
		};
	}

	async invoke(
		options: vscode.LanguageModelToolInvocationOptions<RememberToolInput>,
	): Promise<vscode.LanguageModelToolResult> {
		if (!(await this.core.ensureOnline())) {
			return text("Memanto is not running in this window, so nothing was saved.");
		}
		const agentId = this.core.agentId;
		if (!agentId) return text("No Memanto agent is selected in this window.");

		const input = options.input ?? ({} as RememberToolInput);
		const content = (input.content ?? "").trim();
		if (!content) return text("No content was given, so nothing was saved.");

		try {
			const saved = await this.core.client.remember(agentId, content, {
				type: input.type ?? "fact",
				title: input.title,
				source: "vscode",
				provenance: "inferred",
				confidence: 0.8,
				tags: ["vscode", "copilot"],
			});
			return text(
				`Saved to ${agentId} as ${input.type ?? "fact"}${saved.memory_id ? ` (id ${saved.memory_id})` : ""}.`,
			);
		} catch (error) {
			return text(`Memanto could not save that: ${describe(error)}`);
		}
	}
}

/** Compact, labelled text: the model needs the trust fields, not prose. */
function format(memories: MemoryItem[], query: string, agentId: string): string {
	if (memories.length === 0) {
		return `No memories in Memanto agent "${agentId}" matched "${query}".`;
	}

	const lines = memories.map((memory, index) => {
		const facts = [
			memory.type,
			memory.confidence !== undefined ? `confidence ${memory.confidence}` : null,
			memory.provenance,
			memory.created_at?.slice(0, 10),
			memory.status && memory.status !== "active" ? memory.status.toUpperCase() : null,
		].filter(Boolean);
		return `${index + 1}. ${memoryText(memory)}\n   [${facts.join(", ")}]`;
	});

	return [
		`${memories.length} memories from Memanto agent "${agentId}" for "${query}".`,
		"These are decisions, preferences and facts recorded by this developer's agents. Prefer them over assumptions, and say so when you rely on one.",
		"",
		...lines,
	].join("\n");
}

function clampLimit(requested: number | undefined, fallback: number): number {
	if (!Number.isFinite(requested)) return fallback;
	return Math.min(Math.max(Math.trunc(requested as number), 1), 50);
}

function text(value: string): vscode.LanguageModelToolResult {
	return new vscode.LanguageModelToolResult([new vscode.LanguageModelTextPart(value)]);
}
