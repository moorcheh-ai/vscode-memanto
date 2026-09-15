import assert from "node:assert/strict";
import * as vscode from "vscode";
import { AnswerTool, RecallTool, RememberTool } from "../../src/ai/tools";
import type { MemantoExtensionApi } from "../../src/extension";
import type { MemantoCore } from "../../src/core";

const EXTENSION_ID = "moorcheh-ai.memanto";

/**
 * Runs inside a real VS Code extension host, which is the only place the chat
 * and language model APIs exist. Called by test/integration/runner.mjs.
 */
export async function run(): Promise<void> {
	const failures: string[] = [];
	const check = async (name: string, body: () => Promise<void> | void): Promise<void> => {
		try {
			await body();
			console.log(`  ok  ${name}`);
		} catch (error) {
			failures.push(`${name}: ${(error as Error).message}`);
			console.log(`FAIL  ${name}\n      ${(error as Error).message}`);
		}
	};

	const extension = vscode.extensions.getExtension<MemantoExtensionApi>(EXTENSION_ID);
	assert.ok(extension, `extension ${EXTENSION_ID} not found`);
	const api = await extension.activate();

	await check("activates and registers the chat participant", () => {
		assert.equal(api.participantRegistered, true);
	});

	await check("registers all three language model tools", () => {
		assert.deepEqual(api.toolNames, ["memanto_recall", "memanto_answer", "memanto_remember"]);
	});

	await check("declares the participant in the manifest", () => {
		const participant = extension.packageJSON.contributes.chatParticipants[0];
		assert.equal(participant.id, "memanto.chat");
		assert.equal(participant.name, "memanto");
		assert.deepEqual(
			participant.commands.map((command: { name: string }) => command.name),
			["recall", "recent", "remember"],
		);
	});

	await check("exposes the tools to the model with descriptions", () => {
		const names = vscode.lm.tools.map((tool) => tool.name);
		for (const expected of ["memanto_recall", "memanto_answer", "memanto_remember"]) {
			assert.ok(names.includes(expected), `${expected} missing from vscode.lm.tools`);
		}
		const recall = vscode.lm.tools.find((tool) => tool.name === "memanto_recall");
		assert.ok((recall?.description ?? "").length > 40, "recall tool has no model description");
	});

	await check("registers every command", async () => {
		const commands = await vscode.commands.getCommands(true);
		for (const id of [
			"memanto.openChat",
			"memanto.recall",
			"memanto.answer",
			"memanto.rememberSelection",
			"memanto.selectAgent",
			"memanto.startServer",
			"memanto.stopServer",
			"memanto.setup",
			"memanto.exportMemories",
		]) {
			assert.ok(commands.includes(id), `${id} not registered`);
		}
	});

	// Invoking the recall tool is the real end-to-end path: it starts the private
	// server, joins the agent's session and queries Memanto.
	let recallText = "";
	await check("recall tool returns memories from a live server", async () => {
		const result = await vscode.lm.invokeTool("memanto_recall", {
			input: { query: "database", limit: 3 },
			toolInvocationToken: undefined,
		});
		recallText = textOf(result);
		assert.ok(recallText.length > 0, "tool returned no text");
		assert.ok(
			!/not running|could not/i.test(recallText),
			`tool could not reach Memanto: ${recallText.slice(0, 200)}`,
		);
		assert.match(recallText, /memories from Memanto agent|No memories in Memanto agent/);
	});

	await check("recall output carries the trust fields the model needs", () => {
		if (recallText.startsWith("No memories")) return; // nothing to label
		assert.match(recallText, /confidence \d/);
		assert.match(recallText, /\d{4}-\d{2}-\d{2}/);
	});

	await check("answer tool returns a grounded answer from a live server", async () => {
		const result = await vscode.lm.invokeTool("memanto_answer", {
			input: { question: "What database did we choose?", limit: 5 },
			toolInvocationToken: undefined,
		});
		const answer = textOf(result);
		assert.ok(answer.length > 0, "tool returned no text");
		assert.ok(
			!/not running|could not/i.test(answer),
			`tool could not reach Memanto: ${answer.slice(0, 200)}`,
		);
		assert.match(answer, /grounded in agent/);
	});

	await check("both read tools run without asking the user", async () => {
		const core = { agentId: "test-agent", settings: { recallLimit: 10 } } as unknown as MemantoCore;
		for (const tool of [new RecallTool(core), new AnswerTool(core)]) {
			const prepared = await tool.prepareInvocation({
				input: { query: "x", question: "x" },
			} as never);
			assert.equal(
				prepared?.confirmationMessages,
				undefined,
				"a read-only tool should not prompt",
			);
		}
	});

	// The write tool must ask first. Checked through prepareInvocation directly,
	// so the test never writes to the user's real memory estate.
	await check("remember tool asks for confirmation before writing", async () => {
		const core = { agentId: "test-agent" } as unknown as MemantoCore;
		const prepared = await new RememberTool(core).prepareInvocation({
			input: { content: "We chose Postgres", type: "decision" },
		} as never);
		assert.ok(prepared?.confirmationMessages, "no confirmation prompt on the write tool");
		assert.match(prepared.confirmationMessages.title, /Remember this/);
	});

	await check("stops the server it was using", async () => {
		const before = api.serverState();
		assert.ok(before.pid !== null, `no server was owned (status ${before.status})`);
		assert.ok(before.baseUrl, "no base URL recorded");

		await vscode.commands.executeCommand("memanto.stopServer");

		const after = api.serverState();
		assert.equal(after.pid, null, "server pid is still tracked after stopping");
		// Prove it at the socket, not just in our own state.
		await new Promise((resolve) => setTimeout(resolve, 1000));
		let answering = true;
		try {
			const response = await fetch(`${before.baseUrl}/health`, {
				signal: AbortSignal.timeout(2000),
			});
			answering = response.ok;
		} catch {
			answering = false;
		}
		assert.equal(answering, false, `${before.baseUrl} is still answering after stop`);
	});

	if (failures.length > 0) {
		throw new Error(`${failures.length} integration check(s) failed:\n - ${failures.join("\n - ")}`);
	}
	console.log(`\nAll integration checks passed.`);
}

function textOf(result: vscode.LanguageModelToolResult): string {
	return result.content
		.map((part) => (part instanceof vscode.LanguageModelTextPart ? part.value : ""))
		.join("\n")
		.trim();
}
