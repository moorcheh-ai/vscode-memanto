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
exports.showSetup = showSetup;
const vscode = __importStar(require("vscode"));
const KEY_CONSOLE_URL = "https://console.moorcheh.ai/api-keys";
/**
 * The setup walkthrough.
 *
 * This extension deliberately installs nothing. Each step is a command the user
 * runs themselves, offered as "copy" so nothing is executed on their behalf, and
 * steps already satisfied are shown as done rather than hidden.
 */
async function showSetup(core) {
    const environment = core.environment ?? (await core.refresh());
    const keySettled = environment.hasApiKey || environment.backend === "on-prem";
    const steps = [
        {
            label: "Install Memanto",
            detail: "A Python command line tool. Needs Python 3.11 or newer.",
            done: Boolean(environment.binaryPath),
            command: "pip install memanto",
            alternatives: ["uv tool install memanto", "pipx install memanto"],
        },
        {
            label: "Get a key, or choose on-prem",
            detail: "Cloud: a free key, 100,000 operations, no card. On-prem: no key, runs on Docker.",
            done: keySettled,
            link: KEY_CONSOLE_URL,
        },
        {
            label: "Configure Memanto",
            detail: "Answers a few prompts, then stores your backend choice and key.",
            done: environment.hasConfig,
            command: "memanto",
        },
        {
            label: "Start the server",
            detail: "The extension starts a private server for you the first time you use Memanto.",
            done: environment.serverUp,
            command: "memanto serve",
        },
    ];
    const remaining = steps.filter((step) => !step.done).length;
    const items = steps.map((step, index) => ({
        label: `${step.done ? "$(pass-filled)" : `$(circle-outline) ${index + 1}.`} ${step.label}`,
        detail: step.detail,
        description: step.command ? step.command : step.link ? "opens in your browser" : "",
        step,
    }));
    items.push({ label: "", kind: vscode.QuickPickItemKind.Separator }, { label: "$(refresh) Check again", description: "Re-run detection after finishing a step" });
    const picked = await vscode.window.showQuickPick(items, {
        title: remaining === 0
            ? "Memanto is ready"
            : `Set up Memanto — ${remaining} step${remaining === 1 ? "" : "s"} left`,
        placeHolder: "Pick a step to copy its command",
        matchOnDetail: true,
    });
    if (!picked)
        return;
    if (!picked.step) {
        await core.refresh();
        await showSetup(core);
        return;
    }
    await runStep(picked.step, core);
}
async function runStep(step, core) {
    if (step.link) {
        await vscode.env.openExternal(vscode.Uri.parse(step.link));
        return;
    }
    if (!step.command)
        return;
    const choices = [step.command, ...(step.alternatives ?? [])];
    const command = choices.length === 1
        ? choices[0]
        : await vscode.window.showQuickPick(choices, {
            title: step.label,
            placeHolder: "Pick the command for your setup, then paste it in a terminal",
        });
    if (!command)
        return;
    await vscode.env.clipboard.writeText(command);
    const next = await vscode.window.showInformationMessage(`Copied: ${command}`, "Open terminal", "Check again");
    if (next === "Open terminal") {
        const terminal = vscode.window.createTerminal("Memanto setup");
        terminal.show();
        // Typed, never sent: the user presses Enter themselves.
        terminal.sendText(command, false);
    }
    else if (next === "Check again") {
        await core.refresh();
        await showSetup(core);
    }
}
