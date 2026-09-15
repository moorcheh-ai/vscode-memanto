"use strict";
/**
 * Shapes mirrored from the Memanto OpenAPI contract
 * (`sdks/typescript/openapi.json` in moorcheh-ai/memanto).
 *
 * Only the fields this extension reads are declared. Every field is optional
 * unless the spec marks it required, because a server one minor version behind
 * may omit it.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.MEMORY_TYPES = void 0;
exports.memoryText = memoryText;
exports.memoryLabel = memoryLabel;
/** The 13 memory categories Memanto recognises, in the order the CLI lists them. */
exports.MEMORY_TYPES = [
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
/** Text of a memory, whichever field the server used to carry it. */
function memoryText(memory) {
    return (memory.content ?? memory.text ?? "").trim();
}
/** Short label for lists and trees. */
function memoryLabel(memory) {
    const title = memory.title?.trim();
    if (title)
        return title;
    const text = memoryText(memory).split("\n")[0];
    return text.length > 80 ? `${text.slice(0, 79)}…` : text || "Untitled memory";
}
