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
exports.MemoriesTreeProvider = void 0;
const vscode = __importStar(require("vscode"));
const core_1 = require("../core");
const types_1 = require("../types");
/**
 * Browse the agent's memories by type.
 *
 * Types are listed up front and their memories are fetched only when a type is
 * expanded, so opening the view costs one request at most rather than thirteen.
 */
class MemoriesTreeProvider {
    core;
    emitter = new vscode.EventEmitter();
    onDidChangeTreeData = this.emitter.event;
    constructor(core) {
        this.core = core;
        core.onDidChangeStatus(() => this.refresh());
        core.onDidChangeAgent(() => this.refresh());
    }
    refresh() {
        this.emitter.fire(undefined);
    }
    getTreeItem(node) {
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
        const item = new vscode.TreeItem((0, types_1.memoryLabel)(memory), vscode.TreeItemCollapsibleState.None);
        item.description = [
            memory.confidence !== undefined ? `${Math.round(memory.confidence * 100)}%` : null,
            memory.created_at?.slice(0, 10) ?? null,
        ]
            .filter(Boolean)
            .join(" · ");
        item.tooltip = new vscode.MarkdownString(`${(0, types_1.memoryText)(memory)}\n\n---\n\n${[
            memory.type && `**Type** ${memory.type}`,
            memory.provenance && `**Provenance** ${memory.provenance.replace(/_/g, " ")}`,
            memory.source && `**Source** ${memory.source}`,
            memory.status && `**Status** ${memory.status}`,
        ]
            .filter(Boolean)
            .join("  \n")}`);
        item.iconPath = new vscode.ThemeIcon(memory.status === "active" ? "circle-filled" : "circle");
        item.contextValue = "memantoMemory";
        item.command = {
            command: "memanto.openMemory",
            title: "Open memory",
            arguments: [memory],
        };
        return item;
    }
    async getChildren(node) {
        if (!this.core.online || !this.core.agentId)
            return [];
        if (!node)
            return types_1.MEMORY_TYPES.map((type) => ({ kind: "type", type }));
        if (node.kind !== "type")
            return [];
        try {
            const response = await this.core.client.recallRecent(this.core.agentId, {
                limit: 50,
                types: [node.type],
            });
            if (response.memories.length === 0) {
                return [{ kind: "message", text: "No memories of this type" }];
            }
            return response.memories.map((memory) => ({ kind: "memory", memory }));
        }
        catch (error) {
            return [{ kind: "message", text: (0, core_1.describe)(error) }];
        }
    }
}
exports.MemoriesTreeProvider = MemoriesTreeProvider;
