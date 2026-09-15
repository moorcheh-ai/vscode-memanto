/**
 * Shapes mirrored from the Memanto OpenAPI contract
 * (`sdks/typescript/openapi.json` in moorcheh-ai/memanto).
 *
 * Only the fields this extension reads are declared. Every field is optional
 * unless the spec marks it required, because a server one minor version behind
 * may omit it.
 */

/** The 13 memory categories Memanto recognises, in the order the CLI lists them. */
export const MEMORY_TYPES = [
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
] as const;

export type MemoryType = (typeof MEMORY_TYPES)[number];

export interface MemoryItem {
	id?: string;
	title?: string;
	/** Some server versions populate `content`, others `text`. Read both. */
	content?: string;
	text?: string;
	type?: string;
	confidence?: number;
	status?: string;
	tags?: string[];
	created_at?: string;
	updated_at?: string;
	expired_at?: string;
	source?: string;
	source_ref?: string;
	agent_id?: string;
	score?: number;
	provenance?: string;
}

export interface AgentInfo {
	agent_id: string;
	namespace: string;
	pattern: string;
	description?: string | null;
	created_at: string;
	memory_count?: number | null;
	session_count?: number | null;
	status?: string | null;
}

export interface AgentList {
	agents: AgentInfo[];
	count: number;
}

export interface Session {
	session_id: string;
	session_token: string;
	agent_id: string;
	namespace: string;
	started_at: string;
	expires_at: string;
}

export interface RecallResponse {
	agent_id: string;
	query: string;
	memories: MemoryItem[];
	count: number;
}

export interface TemporalRecallResponse {
	agent_id: string;
	memories: MemoryItem[];
	count: number;
	temporal_mode: string;
}

export interface AnswerResponse {
	agent_id: string;
	question: string;
	answer: string;
	sources?: MemoryItem[] | null;
}

export interface RememberResponse {
	memory_id?: string;
	agent_id?: string;
	status?: string;
}

/** Text of a memory, whichever field the server used to carry it. */
export function memoryText(memory: MemoryItem): string {
	return (memory.content ?? memory.text ?? "").trim();
}

/** Short label for lists and trees. */
export function memoryLabel(memory: MemoryItem): string {
	const title = memory.title?.trim();
	if (title) return title;
	const text = memoryText(memory).split("\n")[0];
	return text.length > 80 ? `${text.slice(0, 79)}…` : text || "Untitled memory";
}
