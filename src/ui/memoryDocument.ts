import * as vscode from "vscode";
import { memoryLabel, memoryText, type MemoryItem } from "../types";

export const MEMORY_SCHEME = "memanto";

/**
 * Opens memories as read-only editor tabs instead of writing files.
 *
 * A memory is a record on the server, not a document the user owns, so it is
 * served from a virtual scheme: nothing lands in the workspace, and nothing has
 * to be cleaned up later.
 */
export class MemoryDocumentProvider implements vscode.TextDocumentContentProvider {
	private readonly contents = new Map<string, string>();

	register(memory: MemoryItem): vscode.Uri {
		const agent = memory.agent_id ?? "memory";
		const id = memory.id ?? String(Date.now());
		const uri = vscode.Uri.parse(`${MEMORY_SCHEME}:/${agent}/${slug(memoryLabel(memory))}.md`).with(
			{ query: id },
		);
		this.contents.set(uri.toString(), render(memory));
		return uri;
	}

	provideTextDocumentContent(uri: vscode.Uri): string {
		return this.contents.get(uri.toString()) ?? "This memory is no longer loaded.";
	}
}

let provider: MemoryDocumentProvider | null = null;

export function registerMemoryDocuments(context: vscode.ExtensionContext): MemoryDocumentProvider {
	provider = new MemoryDocumentProvider();
	context.subscriptions.push(
		vscode.workspace.registerTextDocumentContentProvider(MEMORY_SCHEME, provider),
	);
	return provider;
}

/**
 * A link that opens this memory as a tab, for chat responses. Null before the
 * provider is registered, which only happens outside activation.
 */
export function memoryUri(memory: MemoryItem): vscode.Uri | null {
	return provider ? provider.register(memory) : null;
}

export async function openMemoryDocument(memory: MemoryItem | undefined): Promise<void> {
	if (!memory || !provider) return;
	const uri = provider.register(memory);
	const document = await vscode.workspace.openTextDocument(uri);
	await vscode.languages.setTextDocumentLanguage(document, "markdown");
	await vscode.window.showTextDocument(document, { preview: true });
}

/** A memory as Markdown, with its trust fields in frontmatter like an OKF note. */
function render(memory: MemoryItem): string {
	const front: string[] = ["---", `type: ${memory.type ?? "unknown"}`];
	if (memory.title) front.push(`title: ${JSON.stringify(memory.title)}`);
	if (memory.tags?.length) front.push(`tags: [${memory.tags.join(", ")}]`);
	if (memory.confidence !== undefined) front.push(`confidence: ${memory.confidence}`);
	if (memory.provenance) front.push(`provenance: ${memory.provenance}`);
	if (memory.source) front.push(`source: ${memory.source}`);
	if (memory.status) front.push(`status: ${memory.status}`);
	if (memory.created_at) front.push(`created_at: ${memory.created_at}`);
	if (memory.id) front.push(`id: ${memory.id}`);
	front.push("---", "");

	return `${front.join("\n")}${memoryText(memory)}\n`;
}

/** Line comment syntax per language, for the citation line after an insert. */
const COMMENT: Record<string, string> = {
	python: "#",
	shellscript: "#",
	powershell: "#",
	yaml: "#",
	ruby: "#",
	makefile: "#",
	markdown: ">",
	plaintext: "",
};

/**
 * Insert into the file the user was last editing.
 *
 * The chat webview holds focus while its buttons are clicked, so
 * `activeTextEditor` can be undefined; `visibleTextEditors` still has the file.
 */
export async function insertIntoEditor(
	text: string,
	memory: MemoryItem | undefined,
	cite: boolean,
): Promise<void> {
	const editor =
		vscode.window.activeTextEditor ??
		vscode.window.visibleTextEditors.find((candidate) => candidate.document.uri.scheme === "file");

	if (!editor) {
		void vscode.window.showWarningMessage("Memanto: open a file first, then insert.");
		return;
	}

	let payload = text;
	if (cite && memory) {
		const marker = COMMENT[editor.document.languageId] ?? "//";
		const facts = [memory.type, memory.provenance, memory.created_at?.slice(0, 10)]
			.filter(Boolean)
			.join(", ");
		if (marker) payload = `${text}\n${marker} Memanto${facts ? ` (${facts})` : ""}`;
	}

	await editor.edit((builder) => {
		for (const selection of editor.selections) {
			builder.replace(selection, payload);
		}
	});
	await vscode.window.showTextDocument(editor.document, editor.viewColumn);
}

function slug(value: string): string {
	return (
		value
			.toLowerCase()
			.replace(/[^a-z0-9]+/g, "-")
			.replace(/^-|-$/g, "")
			.slice(0, 60) || "memory"
	);
}
