import * as vscode from "vscode";
import type { MemantoCore } from "../core";

const KEY_CONSOLE_URL = "https://console.moorcheh.ai/api-keys";

interface Step {
	label: string;
	detail: string;
	done: boolean;
	command?: string;
	alternatives?: string[];
	link?: string;
}

/**
 * The setup walkthrough.
 *
 * This extension deliberately installs nothing. Each step is a command the user
 * runs themselves, offered as "copy" so nothing is executed on their behalf, and
 * steps already satisfied are shown as done rather than hidden.
 */
export async function showSetup(core: MemantoCore): Promise<void> {
	const environment = core.environment ?? (await core.refresh());
	const keySettled = environment.hasApiKey || environment.backend === "on-prem";

	const steps: Step[] = [
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
	const items: (vscode.QuickPickItem & { step?: Step })[] = steps.map((step, index) => ({
		label: `${step.done ? "$(pass-filled)" : `$(circle-outline) ${index + 1}.`} ${step.label}`,
		detail: step.detail,
		description: step.command ? step.command : step.link ? "opens in your browser" : "",
		step,
	}));

	items.push(
		{ label: "", kind: vscode.QuickPickItemKind.Separator },
		{ label: "$(refresh) Check again", description: "Re-run detection after finishing a step" },
	);

	const picked = await vscode.window.showQuickPick(items, {
		title:
			remaining === 0
				? "Memanto is ready"
				: `Set up Memanto — ${remaining} step${remaining === 1 ? "" : "s"} left`,
		placeHolder: "Pick a step to copy its command",
		matchOnDetail: true,
	});

	if (!picked) return;

	if (!picked.step) {
		await core.refresh();
		await showSetup(core);
		return;
	}

	await runStep(picked.step, core);
}

async function runStep(step: Step, core: MemantoCore): Promise<void> {
	if (step.link) {
		await vscode.env.openExternal(vscode.Uri.parse(step.link));
		return;
	}
	if (!step.command) return;

	const choices = [step.command, ...(step.alternatives ?? [])];
	const command =
		choices.length === 1
			? choices[0]
			: await vscode.window.showQuickPick(choices, {
					title: step.label,
					placeHolder: "Pick the command for your setup, then paste it in a terminal",
				});
	if (!command) return;

	await vscode.env.clipboard.writeText(command);
	const next = await vscode.window.showInformationMessage(
		`Copied: ${command}`,
		"Open terminal",
		"Check again",
	);

	if (next === "Open terminal") {
		const terminal = vscode.window.createTerminal("Memanto setup");
		terminal.show();
		// Typed, never sent: the user presses Enter themselves.
		terminal.sendText(command, false);
	} else if (next === "Check again") {
		await core.refresh();
		await showSetup(core);
	}
}
