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
exports.createStatusItem = createStatusItem;
const vscode = __importStar(require("vscode"));
/** Status bar entry: whether Memanto is reachable, and which agent is in use. */
function createStatusItem(core) {
    const item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 90);
    item.command = "memanto.openChat";
    const update = () => {
        const agent = core.agentId;
        switch (core.status) {
            case "starting":
                item.text = "$(sync~spin) Memanto";
                item.tooltip = "Starting the Memanto server";
                break;
            case "checking":
                item.text = "$(sync~spin) Memanto";
                item.tooltip = "Looking for Memanto";
                break;
            case "online":
                item.text = `$(database) ${agent ?? "Memanto"}`;
                item.tooltip = new vscode.MarkdownString(`Memanto is running at \`${core.environment?.baseUrl ?? ""}\`${core.serverPid ? ` (pid ${core.serverPid})` : ""}.\n\nClick to open the chat.`);
                break;
            case "offline":
                item.text = "$(debug-disconnect) Memanto";
                item.tooltip = core.lastServerError ?? "Memanto is not running. Click to set it up.";
                break;
            default:
                item.text = "$(database) Memanto";
                item.tooltip = "Click to open the Memanto chat";
        }
        item.backgroundColor = undefined;
        item.show();
    };
    core.onDidChangeStatus(update);
    core.onDidChangeAgent(update);
    update();
    return item;
}
