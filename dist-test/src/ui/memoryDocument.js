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
exports.MemoryDocumentProvider = exports.MEMORY_SCHEME = void 0;
exports.registerMemoryDocuments = registerMemoryDocuments;
exports.openMemoryDocument = openMemoryDocument;
exports.insertIntoEditor = insertIntoEditor;
const vscode = __importStar(require("vscode"));
const types_1 = require("../types");
exports.MEMORY_SCHEME = "memanto";
/**
 * Opens memories as read-only editor tabs instead of writing files.
 *
 * A memory is a record on the server, not a document the user owns, so it is
 * served from a virtual scheme: nothing lands in the workspace, and nothing has
 * to be cleaned up later.
 */
class MemoryDocumentProvider {
    contents = new Map();
    register(memory) {
        const agent = memory.agent_id ?? "memory";
        const id = memory.id ?? String(Date.now());
        const uri = vscode.Uri.parse(`${exports.MEMORY_SCHEME}:/${agent}/${slug((0, types_1.memoryLabel)(memory))}.md`).with({ query: id });
        this.contents.set(uri.toString(), render(memory));
        return uri;
    }
    provideTextDocumentContent(uri) {
        return this.contents.get(uri.toString()) ?? "This memory is no longer loaded.";
    }
}
exports.MemoryDocumentProvider = MemoryDocumentProvider;
let provider = null;
function registerMemoryDocuments(context) {
    provider = new MemoryDocumentProvider();
    context.subscriptions.push(vscode.workspace.registerTextDocumentContentProvider(exports.MEMORY_SCHEME, provider));
    return provider;
}
async function openMemoryDocument(memory) {
    if (!memory || !provider)
        return;
    const uri = provider.register(memory);
    const document = await vscode.workspace.openTextDocument(uri);
    await vscode.languages.setTextDocumentLanguage(document, "markdown");
    await vscode.window.showTextDocument(document, { preview: true });
}
/** A memory as Markdown, with its trust fields in frontmatter like an OKF note. */
function render(memory) {
    const front = ["---", `type: ${memory.type ?? "unknown"}`];
    if (memory.title)
        front.push(`title: ${JSON.stringify(memory.title)}`);
    if (memory.tags?.length)
        front.push(`tags: [${memory.tags.join(", ")}]`);
    if (memory.confidence !== undefined)
        front.push(`confidence: ${memory.confidence}`);
    if (memory.provenance)
        front.push(`provenance: ${memory.provenance}`);
    if (memory.source)
        front.push(`source: ${memory.source}`);
    if (memory.status)
        front.push(`status: ${memory.status}`);
    if (memory.created_at)
        front.push(`created_at: ${memory.created_at}`);
    if (memory.id)
        front.push(`id: ${memory.id}`);
    front.push("---", "");
    return `${front.join("\n")}${(0, types_1.memoryText)(memory)}\n`;
}
/** Line comment syntax per language, for the citation line after an insert. */
const COMMENT = {
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
async function insertIntoEditor(text, memory, cite) {
    const editor = vscode.window.activeTextEditor ??
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
        if (marker)
            payload = `${text}\n${marker} Memanto${facts ? ` (${facts})` : ""}`;
    }
    await editor.edit((builder) => {
        for (const selection of editor.selections) {
            builder.replace(selection, payload);
        }
    });
    await vscode.window.showTextDocument(editor.document, editor.viewColumn);
}
function slug(value) {
    return (value
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-|-$/g, "")
        .slice(0, 60) || "memory");
}
