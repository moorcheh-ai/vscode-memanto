import * as vscode from "vscode";
import { describe, type MemantoCore } from "../core";
import { memoryLabel, memoryText, type MemoryItem } from "../types";
import { memoryUri } from "../ui/memoryDocument";

export const PARTICIPANT_ID = "memanto.chat";

/**
 * `@memanto` in the chat panel.
 *
 * Copilot Chat is where people already type questions, so this puts recall and
 * answer there as well as in the sidebar. Every reply says which one produced
 * it, for the same reason the sidebar labels them: a ranked list of stored
 * memories and a written answer are different kinds of evidence.
 *
 * Returns null on a VS Code without the chat API, so activation still succeeds.
 */
export function registerParticipant(
	core: MemantoCore,
	context: vscode.ExtensionContext,
): vscode.Disposable | null {
	if (typeof vscode.chat?.createChatParticipant !== "function") return null;

	const handler: vscode.ChatRequestHandler = async (request, _chatContext, stream, token) => {
		if (!(await core.ensureOnline())) {
			stream.markdown(
				core.lastServerError
					? `Memanto could not start: ${core.lastServerError}\n\n`
					: "Memanto is not set up in this window yet.\n\n",
			);
			stream.button({ command: "memanto.setup", title: "Setup steps" });
			return {};
		}

		const agentId = core.agentId;
		if (!agentId) {
			stream.markdown("No agent is selected for this window.\n\n");
			stream.button({ command: "memanto.selectAgent", title: "Select agent" });
			return {};
		}

		const prompt = request.prompt.trim();

		try {
			switch (request.command) {
				case "recall":
					await runRecall(core, agentId, prompt, stream, token);
					break;
				case "recent":
					await runRecent(core, agentId, stream);
					break;
				case "remember":
					await runRemember(core, agentId, prompt, stream);
					break;
				default:
					await runAnswer(core, agentId, prompt, stream);
			}
		} catch (error) {
			stream.markdown(`Memanto could not answer: ${describe(error)}`);
		}

		return { metadata: { command: request.command ?? "answer", agentId } };
	};

	const participant = vscode.chat.createChatParticipant(PARTICIPANT_ID, handler);
	participant.iconPath = vscode.Uri.joinPath(context.extensionUri, "resources", "icon.png");
	participant.followupProvider = {
		provideFollowups(result) {
			const command = (result.metadata as { command?: string } | undefined)?.command;
			if (command === "recall" || command === "recent") {
				return [{ prompt: "Summarise what these memories mean for this project" }];
			}
			return [{ prompt: "Show the memories behind that", command: "recall" }];
		},
	};

	return participant;
}

async function runAnswer(
	core: MemantoCore,
	agentId: string,
	prompt: string,
	stream: vscode.ChatResponseStream,
): Promise<void> {
	if (!prompt) {
		stream.markdown("Ask a question, or use `/recall` to list matching memories.");
		return;
	}

	stream.progress(`Asking ${agentId}…`);
	const response = await core.client.answer(agentId, prompt);
	stream.markdown(response.answer?.trim() || "Memanto had nothing to say about that.");

	const sources = response.sources ?? [];
	if (sources.length === 0) return;

	stream.markdown(`\n\n**Based on ${sources.length} ${plural(sources.length, "memory", "memories")}**\n\n`);
	for (const source of sources) anchor(stream, source);
}

async function runRecall(
	core: MemantoCore,
	agentId: string,
	prompt: string,
	stream: vscode.ChatResponseStream,
	_token: vscode.CancellationToken,
): Promise<void> {
	if (!prompt) {
		stream.markdown("Say what to search for, for example `@memanto /recall database`.");
		return;
	}

	stream.progress(`Searching ${agentId}…`);
	const response = await core.client.recall(agentId, prompt, { limit: core.settings.recallLimit });
	render(stream, response.memories, `No memories matched “${prompt}”.`);
}

async function runRecent(
	core: MemantoCore,
	agentId: string,
	stream: vscode.ChatResponseStream,
): Promise<void> {
	stream.progress(`Loading recent memories from ${agentId}…`);
	const response = await core.client.recallRecent(agentId, { limit: core.settings.recallLimit });
	render(stream, response.memories, "This agent has no memories yet.");
}

/**
 * Saving from chat is an explicit request, so it needs no extra confirmation.
 * The tool version does, because there the model decides.
 */
async function runRemember(
	core: MemantoCore,
	agentId: string,
	prompt: string,
	stream: vscode.ChatResponseStream,
): Promise<void> {
	if (!prompt) {
		stream.markdown("Say what to remember, for example `@memanto /remember we chose Postgres`.");
		return;
	}

	stream.progress(`Saving to ${agentId}…`);
	await core.client.remember(agentId, prompt, {
		type: "decision",
		source: "vscode",
		provenance: "explicit_statement",
		confidence: 1,
		tags: ["vscode"],
	});
	stream.markdown(`Saved to **${agentId}** as a decision.`);
}

function render(
	stream: vscode.ChatResponseStream,
	memories: MemoryItem[],
	empty: string,
): void {
	if (memories.length === 0) {
		stream.markdown(empty);
		return;
	}

	stream.markdown(`**${memories.length} ${plural(memories.length, "memory", "memories")}**\n\n`);
	for (const memory of memories) {
		const facts = [
			memory.type,
			memory.confidence !== undefined ? `${Math.round(memory.confidence * 100)}% confidence` : null,
			memory.provenance?.replace(/_/g, " "),
			memory.created_at?.slice(0, 10),
		].filter(Boolean);

		stream.markdown(`- ${memoryText(memory)}\n  \n  _${facts.join(" · ")}_\n`);
		anchor(stream, memory);
	}
}

/** Link a memory so the reader can open it as a tab. */
function anchor(stream: vscode.ChatResponseStream, memory: MemoryItem): void {
	const uri = memoryUri(memory);
	if (uri) stream.anchor(uri, memoryLabel(memory));
}

function plural(count: number, one: string, many: string): string {
	return count === 1 ? one : many;
}
