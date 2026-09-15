import DOMPurify from "dompurify";
import { marked } from "marked";

/**
 * The chat webview.
 *
 * Renders and collects input only. Every request, credential and file access
 * happens in the extension host and arrives here as a plain message, so this
 * document never holds a token.
 */

type Status = "idle" | "checking" | "starting" | "online" | "offline";
type Mode = "recall" | "answer";
type Temporal = "search" | "recent" | "as-of" | "changed-since";
type MascotState = "idle" | "walking" | "sleeping";

interface Memory {
	id?: string;
	title?: string;
	content?: string;
	text?: string;
	type?: string;
	confidence?: number;
	status?: string;
	provenance?: string;
	source?: string;
	created_at?: string;
}

interface StateMessage {
	type: "state";
	status: Status;
	agentId: string;
	agents: { id: string; count: number | null }[];
	installed: boolean;
	mode: "private" | "attach";
	address: string;
	error: string | null;
}

interface ReplyMessage {
	type: "reply";
	id: number;
	ok: boolean;
	kind?: "recall" | "answer";
	memories?: Memory[];
	answer?: string;
	sources?: Memory[];
	error?: string;
}

const MEMORY_TYPES = [
	"instruction",
	"fact",
	"decision",
	"goal",
	"commitment",
	"preference",
	"relationship",
	"context",
	"event",
	"learning",
	"observation",
	"artifact",
	"error",
];

const vscode = acquireVsCodeApi<{ mode: Mode }>();

let status: Status = "idle";
let agentId = "";
let agents: { id: string; count: number | null }[] = [];
let installed = false;
let serverError: string | null = null;
let mode: Mode = vscode.getState()?.mode ?? "recall";
let temporal: Temporal = "search";
const selectedTypes = new Set<string>();
let messageCount = 0;
let nextId = 1;
const pending = new Map<number, (reply: ReplyMessage) => void>();

// ------------------------------------------------------------------ helpers

function el<K extends keyof HTMLElementTagNameMap>(
	tag: K,
	options: { cls?: string; text?: string; parent?: Element; attrs?: Record<string, string> } = {},
): HTMLElementTagNameMap[K] {
	const node = document.createElement(tag);
	if (options.cls) node.className = options.cls;
	if (options.text !== undefined) node.textContent = options.text;
	for (const [key, value] of Object.entries(options.attrs ?? {})) node.setAttribute(key, value);
	options.parent?.appendChild(node);
	return node;
}

function memoryText(memory: Memory): string {
	return (memory.content ?? memory.text ?? "").trim();
}

function isoDate(date: Date): string {
	const pad = (value: number): string => String(value).padStart(2, "0");
	return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

function formatDate(value: string): string {
	const date = new Date(value);
	return Number.isNaN(date.getTime())
		? value.slice(0, 10)
		: date.toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
}

// ------------------------------------------------------------------- mascot

const SVG_NS = "http://www.w3.org/2000/svg";
const BODY =
	"M 18,0 H 78 V 24 H 66 V 12 H 60 V 24 H 36 V 12 H 30 V 24 H 18 Z M 12,24 H 18 V 48 H 12 Z M 78,24 H 84 V 48 H 78 Z M 18,48 H 78 V 60 H 66 V 72 H 30 V 60 H 18 Z";
const LEGS_STANDING =
	"M 12,72 H 18 V 108 H 12 Z M 24,72 H 30 V 96 H 24 Z M 36,72 H 42 V 84 H 36 Z M 54,72 H 60 V 84 H 54 Z M 66,72 H 72 V 96 H 66 Z M 78,72 H 84 V 108 H 78 Z";
const LEGS_STRIDE =
	"M 12,72 H 18 V 84 H 12 Z M 12,96 H 18 V 108 H 12 Z M 24,72 H 30 V 96 H 24 Z M 36,72 H 42 V 96 H 36 Z M 54,72 H 60 V 96 H 54 Z M 66,72 H 72 V 96 H 66 Z M 78,72 H 84 V 84 H 78 Z M 78,96 H 84 V 108 H 78 Z";

function svg<K extends keyof SVGElementTagNameMap>(
	tag: K,
	attrs: Record<string, string>,
	parent?: Element,
): SVGElementTagNameMap[K] {
	const node = document.createElementNS(SVG_NS, tag);
	for (const [key, value] of Object.entries(attrs)) node.setAttribute(key, value);
	parent?.appendChild(node);
	return node;
}

/** The Memanto mascot, drawn from the same pixel paths as the official logo. */
function mascot(parent: Element, state: MascotState, cls = ""): HTMLElement {
	const wrap = el("div", { cls: `mascot ${cls}`.trim(), parent, attrs: { "aria-hidden": "true" } });
	const root = svg("svg", { viewBox: "0 0 96 108", fill: "currentColor" }, wrap);
	svg("path", { d: BODY }, root);

	const eyes = svg("g", { class: "eyes" }, root);
	for (const [x, winks] of [
		[42, true],
		[54, false],
	] as [number, boolean][]) {
		const open = svg("g", { class: winks ? "eye-open winks" : "eye-open" }, eyes);
		svg(
			"polygon",
			{
				points: `${x},28 ${x + 4},36 ${x},44 ${x - 4},36`,
				fill: "none",
				stroke: "currentColor",
				"stroke-width": "1.5",
			},
			open,
		);
		svg("polygon", { points: `${x},32 ${x + 2},36 ${x},40 ${x - 2},36` }, open);
		const closed = svg("g", { class: winks ? "eye-closed winks" : "eye-closed" }, eyes);
		svg("rect", { x: String(x - 6), y: "34", width: "12", height: "4" }, closed);
	}

	svg("path", { d: LEGS_STANDING, class: "legs-a" }, root);
	svg("path", { d: LEGS_STRIDE, class: "legs-b" }, root);
	setMascot(wrap, state);
	return wrap;
}

function setMascot(node: HTMLElement, state: MascotState): void {
	node.classList.remove("is-idle", "is-walking", "is-sleeping");
	node.classList.add(`is-${state}`);
}

// -------------------------------------------------------------------- shell

const root = document.getElementById("root") as HTMLElement;
const header = el("div", { cls: "header", parent: root });
const headerTop = el("div", { cls: "header-top", parent: header });
const brand = el("div", { cls: "brand", parent: headerTop });
const headerMascot = mascot(brand, "idle", "is-small");
el("span", { cls: "wordmark", text: "Memanto", parent: brand });
const statusPill = el("div", { cls: "status", parent: brand });

const headerActions = el("div", { cls: "header-actions", parent: headerTop });
iconButton(headerActions, "Clear conversation", "clear", () => clearThread());
iconButton(headerActions, "Memanto settings", "gear", () =>
	post({ type: "run", command: "workbench.action.openSettings", args: "memanto" }),
);

const agentRow = el("div", { cls: "agent-row", parent: header });
const agentButton = el("button", { cls: "agent", parent: agentRow });
agentButton.addEventListener("click", () => post({ type: "run", command: "memanto.selectAgent" }));

const thread = el("div", { cls: "thread", parent: root });
let panel: HTMLElement | null = null;

const composer = el("div", { cls: "composer", parent: root });
const toggle = el("div", { cls: "toggle", parent: composer, attrs: { role: "tablist" } });
el("div", { cls: "toggle-thumb", parent: toggle });
const modeButtons = new Map<Mode, HTMLButtonElement>();
for (const [value, label] of [
	["recall", "Recall"],
	["answer", "Answer"],
] as [Mode, string][]) {
	const button = el("button", { cls: "toggle-option", parent: toggle, attrs: { role: "tab" } });
	el("span", { cls: "toggle-label", text: label, parent: button });
	button.addEventListener("click", () => setMode(value));
	modeButtons.set(value, button);
}

const options = el("div", { cls: "options", parent: composer });
let dateInput: HTMLInputElement | null = null;

const inputBox = el("div", { cls: "input-box", parent: composer });
const input = el("textarea", {
	cls: "input",
	parent: inputBox,
	attrs: { rows: "1", id: "memanto-input" },
});
const send = el("button", { cls: "send", parent: inputBox, attrs: { "aria-label": "Send" } });
send.appendChild(icon("send"));
send.addEventListener("click", () => void submit());

input.addEventListener("input", grow);
input.addEventListener("keydown", (event) => {
	if (event.key === "Enter" && !event.shiftKey && !event.isComposing) {
		event.preventDefault();
		void submit();
	}
});

el("div", { cls: "hint", text: "Enter to send · Shift+Enter for a new line", parent: composer });

function iconButton(parent: Element, label: string, name: string, onClick: () => void): void {
	const button = el("button", { cls: "icon-button", parent, attrs: { "aria-label": label, title: label } });
	button.appendChild(icon(name));
	button.addEventListener("click", onClick);
}

/** Small inline glyphs: the webview cannot use VS Code's codicon font. */
function icon(name: string): SVGSVGElement {
	const paths: Record<string, string> = {
		search: "M10.5 3a7.5 7.5 0 1 0 4.55 13.45l4.25 4.25 1.4-1.4-4.25-4.25A7.5 7.5 0 0 0 10.5 3Zm0 2a5.5 5.5 0 1 1 0 11 5.5 5.5 0 0 1 0-11Z",
		sparkle: "M12 2l1.8 5.2L19 9l-5.2 1.8L12 16l-1.8-5.2L5 9l5.2-1.8L12 2Zm6 11l.9 2.6L21.5 17l-2.6.9L18 20.5l-.9-2.6L14.5 17l2.6-.9L18 13Z",
		send: "M4 12l16-8-8 16-2-6-6-2Z",
		copy: "M8 3h9a2 2 0 0 1 2 2v11h-2V5H8V3Zm-3 4h9a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V9a2 2 0 0 1 2-2Zm0 2v10h9V9H5Z",
		insert: "M4 5h16v2H4V5Zm0 6h10v2H4v-2Zm0 6h16v2H4v-2Zm14-6.5L22 13l-4 2.5v-5Z",
		open: "M6 2h8l4 4v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2Zm7 1.5V7h3.5L13 3.5ZM8 12h8v2H8v-2Zm0 4h8v2H8v-2Z",
		clear: "M7 4h10l-1 16H8L7 4Zm2-2h6v2H9V2Z",
		gear: "M12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8Zm9 4c0-.6-.05-1.2-.15-1.75l2.1-1.6-2-3.46-2.5 1a7.9 7.9 0 0 0-3-1.74L15 2H9l-.45 2.45a7.9 7.9 0 0 0-3 1.74l-2.5-1-2 3.46 2.1 1.6a8.2 8.2 0 0 0 0 3.5l-2.1 1.6 2 3.46 2.5-1a7.9 7.9 0 0 0 3 1.74L9 22h6l.45-2.45a7.9 7.9 0 0 0 3-1.74l2.5 1 2-3.46-2.1-1.6c.1-.55.15-1.15.15-1.75Z",
		filter: "M3 5h18l-7 8v6l-4 2v-8L3 5Z",
	};
	const node = document.createElementNS(SVG_NS, "svg");
	node.setAttribute("viewBox", "0 0 24 24");
	node.setAttribute("fill", "currentColor");
	node.setAttribute("aria-hidden", "true");
	svg("path", { d: paths[name] ?? paths.search }, node);
	return node;
}

// --------------------------------------------------------------- mode & options

function setMode(next: Mode): void {
	mode = next;
	vscode.setState({ mode });
	toggle.setAttribute("data-active", mode);
	for (const [value, button] of modeButtons) {
		button.classList.toggle("is-active", value === mode);
		button.setAttribute("aria-selected", String(value === mode));
		const existing = button.querySelector("svg");
		existing?.remove();
		button.insertBefore(icon(value === "recall" ? "search" : "sparkle"), button.firstChild);
	}
	renderOptions();
	updatePlaceholder();
	if (messageCount === 0) renderPanel();
}

function renderOptions(): void {
	options.innerHTML = "";
	dateInput = null;
	options.classList.toggle("is-hidden", mode !== "recall");
	if (mode !== "recall") return;

	const select = el("select", { cls: "select", parent: options });
	for (const [value, label] of [
		["search", "Search"],
		["recent", "Most recent"],
		["as-of", "As of date"],
		["changed-since", "Changed since"],
	] as [Temporal, string][]) {
		const option = el("option", { text: label, parent: select });
		option.value = value;
		option.selected = value === temporal;
	}
	select.addEventListener("change", () => {
		temporal = select.value as Temporal;
		renderOptions();
		updatePlaceholder();
	});

	if (temporal === "as-of" || temporal === "changed-since") {
		dateInput = el("input", { cls: "date", parent: options });
		dateInput.type = "date";
		const when = new Date();
		if (temporal === "changed-since") when.setDate(when.getDate() - 7);
		dateInput.value = isoDate(when);
	}

	const typesButton = el("button", { cls: "types", parent: options });
	typesButton.appendChild(icon("filter"));
	const typesLabel = el("span", {
		text: selectedTypes.size ? `${selectedTypes.size} types` : "All types",
		parent: typesButton,
	});
	typesButton.classList.toggle("is-active", selectedTypes.size > 0);

	const tray = el("div", { cls: "tray is-hidden", parent: options });
	typesButton.addEventListener("click", () => tray.classList.toggle("is-hidden"));

	for (const type of MEMORY_TYPES) {
		const chip = el("button", { cls: "chip", text: type, parent: tray });
		chip.classList.toggle("is-active", selectedTypes.has(type));
		chip.addEventListener("click", () => {
			if (selectedTypes.has(type)) selectedTypes.delete(type);
			else selectedTypes.add(type);
			chip.classList.toggle("is-active", selectedTypes.has(type));
			typesLabel.textContent = selectedTypes.size ? `${selectedTypes.size} types` : "All types";
			typesButton.classList.toggle("is-active", selectedTypes.size > 0);
		});
	}
}

function updatePlaceholder(): void {
	input.placeholder =
		mode === "answer"
			? "Ask about anything your agents learned…"
			: temporal === "search"
				? "Search memories…"
				: "Press Enter to load";
}

function grow(): void {
	input.style.height = "auto";
	input.style.height = `${Math.min(input.scrollHeight, 160)}px`;
}

// -------------------------------------------------------------------- panels

function clearPanel(): void {
	panel?.remove();
	panel = null;
}

function renderPanel(): void {
	clearPanel();
	if (messageCount > 0) return;
	panel = el("div", { cls: "panel", parent: thread });

	if (status === "online") {
		mascot(panel, "idle", "is-hero");
		el("h3", {
			text: mode === "answer" ? "Ask your agents' memory" : "Search your agents' memory",
			parent: panel,
		});
		el("p", {
			text:
				mode === "answer"
					? "Answers come from what your agents actually stored: decisions, preferences, facts and lessons."
					: "Everything your agents remembered, ranked by relevance, with confidence and provenance.",
			parent: panel,
		});

		const suggestions: [string, () => void][] =
			mode === "answer"
				? [
						["What have we decided recently?", () => ask("What have we decided recently?")],
						["What are my preferences?", () => ask("What are my preferences?")],
						["What mistakes should I avoid?", () => ask("What mistakes should I avoid repeating?")],
					]
				: [
						["Show recent memories", () => runTemporal("recent")],
						["What changed this week?", () => runTemporal("changed-since")],
						["Find decisions", () => ask("decisions", ["decision"])],
					];
		const list = el("div", { cls: "suggestions", parent: panel });
		for (const [label, run] of suggestions) {
			el("button", { cls: "suggestion", text: label, parent: list }).addEventListener("click", run);
		}
		return;
	}

	if (status === "checking" || status === "starting" || status === "idle") {
		mascot(panel, "walking", "is-hero");
		el("h3", { text: status === "starting" ? "Starting Memanto" : "Looking for Memanto", parent: panel });
		el("p", {
			text:
				status === "starting"
					? "Starting a private server for this window. The first start takes a few seconds."
					: "Checking what is installed…",
			parent: panel,
		});
		return;
	}

	mascot(panel, "sleeping", "is-hero");
	el("h3", { text: installed ? "Memanto is asleep" : "Memanto isn't installed yet", parent: panel });
	el("p", {
		text: installed
			? "The server isn't running for this window."
			: "Install the Memanto CLI to search your agents' memory from here.",
		parent: panel,
	});
	if (serverError) el("p", { cls: "panel-error", text: serverError, parent: panel });

	const buttons = el("div", { cls: "panel-buttons", parent: panel });
	if (installed) {
		el("button", { cls: "primary", text: "Start server", parent: buttons }).addEventListener(
			"click",
			() => post({ type: "run", command: "memanto.startServer" }),
		);
	}
	el("button", {
		cls: installed ? "" : "primary",
		text: "Setup steps",
		parent: buttons,
	}).addEventListener("click", () => post({ type: "run", command: "memanto.setup" }));
}

// ------------------------------------------------------------------ messages

function clearThread(): void {
	thread.innerHTML = "";
	panel = null;
	messageCount = 0;
	renderPanel();
}

function scrollDown(): void {
	thread.scrollTo({ top: thread.scrollHeight, behavior: "smooth" });
}

function addUser(text: string): void {
	clearPanel();
	messageCount++;
	const row = el("div", { cls: "msg is-user", parent: thread });
	el("div", { cls: "bubble", text, parent: row });
	scrollDown();
}

function addAssistant(kind: Mode): { body: HTMLElement; avatar: HTMLElement } {
	clearPanel();
	messageCount++;
	const row = el("div", { cls: "msg is-assistant", parent: thread });
	const avatar = mascot(row, "walking", "is-avatar");
	const body = el("div", { cls: "msg-body", parent: row });
	const label = el("div", { cls: `msg-label is-${kind}`, parent: body });
	label.appendChild(icon(kind === "answer" ? "sparkle" : "search"));
	el("span", { text: kind === "answer" ? "Answer" : "Recall", parent: label });
	return { body, avatar };
}

function addActions(parent: HTMLElement, text: string, memory?: Memory): void {
	const actions = el("div", { cls: "actions", parent });
	iconButton(actions, "Insert into file", "insert", () => post({ type: "insert", text, memory }));
	iconButton(actions, "Copy", "copy", () => post({ type: "copy", text }));
	if (memory?.id) iconButton(actions, "Open memory", "open", () => post({ type: "open", memory }));
}

function renderMemory(parent: HTMLElement, memory: Memory): void {
	const card = el("div", { cls: "card", parent });
	const text = memoryText(memory);

	const meta = el("div", { cls: "card-meta", parent: card });
	if (memory.type) el("span", { cls: "type", text: memory.type, parent: meta });
	if (memory.status && memory.status !== "active") {
		el("span", { cls: "type is-expired", text: memory.status, parent: meta });
	}
	if (typeof memory.confidence === "number") {
		const value = Math.max(0, Math.min(1, memory.confidence));
		const bar = el("div", { cls: "confidence", parent: meta });
		const fill = el("div", { cls: value < 0.5 ? "confidence-fill is-low" : "confidence-fill", parent: bar });
		fill.style.width = `${value * 100}%`;
		el("span", { cls: "confidence-value", text: `${Math.round(value * 100)}%`, parent: meta });
	}

	// Memanto derives a title from the first line when none is given, so showing
	// both would stutter.
	const title = memory.title?.replace(/(\.\.\.|…)\s*$/, "").trim();
	if (title && !text.startsWith(title)) el("div", { cls: "card-title", text: memory.title, parent: card });

	const body = el("div", { cls: "card-text", text, parent: card });
	body.addEventListener("click", () => body.classList.toggle("is-expanded"));

	const facts = [
		memory.provenance?.replace(/_/g, " "),
		memory.source,
		memory.created_at ? formatDate(memory.created_at) : null,
	].filter(Boolean);
	if (facts.length) el("div", { cls: "card-facts", text: facts.join(" · "), parent: card });

	addActions(card, text, memory);
}

// -------------------------------------------------------------------- submit

function ask(text: string, types?: string[]): void {
	if (types) {
		selectedTypes.clear();
		for (const type of types) selectedTypes.add(type);
		temporal = "search";
		renderOptions();
	}
	input.value = text;
	void submit();
}

function runTemporal(next: Temporal): void {
	temporal = next;
	renderOptions();
	updatePlaceholder();
	input.value = "";
	void submit();
}

function describeTemporal(): string {
	const date = dateInput?.value ?? isoDate(new Date());
	switch (temporal) {
		case "recent":
			return "Show the most recent memories";
		case "as-of":
			return `What was true as of ${date}?`;
		case "changed-since":
			return `What changed since ${date}?`;
		default:
			return "";
	}
}

async function submit(): Promise<void> {
	if (status !== "online" || send.hasAttribute("disabled")) return;

	const text = input.value.trim();
	const needsText = mode === "answer" || temporal === "search";
	if (needsText && !text) {
		input.focus();
		return;
	}

	const kind = mode;
	addUser(text || describeTemporal());
	input.value = "";
	grow();

	const { body, avatar } = addAssistant(kind);
	const thinking = el("div", { cls: "thinking", parent: body });
	el("span", { text: kind === "answer" ? "Thinking" : "Recalling", parent: thinking });
	const dots = el("span", { cls: "dots", parent: thinking });
	for (let i = 0; i < 3; i++) el("span", { parent: dots });
	scrollDown();

	send.setAttribute("disabled", "true");
	const id = nextId++;
	const reply = await new Promise<ReplyMessage>((resolve) => {
		pending.set(id, resolve);
		post({
			type: "ask",
			id,
			mode: kind,
			text,
			temporal,
			date: dateInput?.value ?? isoDate(new Date()),
			types: [...selectedTypes],
		});
	});

	thinking.remove();
	setMascot(avatar, "idle");
	send.removeAttribute("disabled");

	if (!reply.ok) {
		el("div", { cls: "error", text: reply.error ?? "Something went wrong.", parent: body });
		scrollDown();
		return;
	}

	if (reply.kind === "answer") {
		const answer = (reply.answer ?? "").trim() || "Memanto had nothing to say about that.";
		const content = el("div", { cls: "answer", parent: body });
		content.innerHTML = DOMPurify.sanitize(marked.parse(answer, { async: false }) as string);
		addActions(body, answer, undefined);
		if (reply.sources?.length) {
			const details = el("details", { cls: "sources", parent: body });
			el("summary", {
				text: `${reply.sources.length} source${reply.sources.length === 1 ? "" : "s"}`,
				parent: details,
			});
			for (const source of reply.sources) renderMemory(details, source);
		}
	} else {
		const memories = reply.memories ?? [];
		el("div", {
			cls: "summary",
			text: memories.length
				? `Found ${memories.length} ${memories.length === 1 ? "memory" : "memories"}`
				: "Nothing matched. Try different words, or fewer type filters.",
			parent: body,
		});
		const list = el("div", { cls: "cards", parent: body });
		for (const memory of memories) renderMemory(list, memory);
	}
	scrollDown();
}

// -------------------------------------------------------------------- wiring

function post(message: Record<string, unknown>): void {
	vscode.postMessage(message);
}

function applyState(next: StateMessage): void {
	status = next.status;
	agentId = next.agentId;
	agents = next.agents;
	installed = next.installed;
	serverError = next.error;

	statusPill.className = `status is-${status}`;
	statusPill.textContent = "";
	el("span", { cls: "dot", parent: statusPill });
	el("span", {
		text: { idle: "Idle", checking: "Checking", starting: "Starting", online: "Online", offline: "Offline" }[
			status
		],
		parent: statusPill,
	});
	statusPill.title = next.address || "";

	setMascot(headerMascot, status === "online" ? "idle" : status === "offline" ? "sleeping" : "walking");

	const agent = agents.find((candidate) => candidate.id === agentId);
	agentButton.textContent =
		agentId === ""
			? "Select an agent"
			: agent?.count != null
				? `${agentId} · ${agent.count.toLocaleString()} memories`
				: agentId;

	const online = status === "online";
	input.disabled = !online;
	send.toggleAttribute("disabled", !online);
	agentButton.disabled = status === "checking" || status === "starting";

	if (messageCount === 0) renderPanel();
	else clearPanel();
}

window.addEventListener("message", (event: MessageEvent<StateMessage | ReplyMessage>) => {
	const message = event.data;
	if (message.type === "state") applyState(message);
	else if (message.type === "reply") {
		pending.get(message.id)?.(message);
		pending.delete(message.id);
	}
});

setMode(mode);
renderPanel();
post({ type: "ready" });

declare function acquireVsCodeApi<T>(): {
	postMessage(message: unknown): void;
	getState(): T | undefined;
	setState(state: T): void;
};
