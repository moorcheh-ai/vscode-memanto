// Launches VS Code with the extension loaded and runs dist-test/test/integration/index.js
// inside its extension host, which is the only place the chat and language model
// APIs exist.
//
//   node test/integration/runner.mjs
//
// Uses the VS Code already installed on this machine when one is found, so no
// build is downloaded. Set MEMANTO_VSCODE to point at a different Code binary.
import { runTests } from "@vscode/test-electron";
import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(fileURLToPath(new URL("../..", import.meta.url)));

const installed = [
	process.env.MEMANTO_VSCODE,
	join(process.env.LOCALAPPDATA ?? "", "Programs", "Microsoft VS Code", "Code.exe"),
	"/usr/share/code/code",
	"/Applications/Visual Studio Code.app/Contents/MacOS/Electron",
].find((candidate) => candidate && existsSync(candidate));

const userDataDir = mkdtempSync(join(tmpdir(), "memanto-vscode-test-"));

await runTests({
	vscodeExecutablePath: installed,
	extensionDevelopmentPath: root,
	extensionTestsPath: join(root, "dist-test", "test", "integration", "index.js"),
	launchArgs: [
		join(root, "test", "fixtures", "workspace"),
		// Isolated profile: never touch the developer's own VS Code state, and
		// make sure the window is a fresh instance rather than a forwarded folder.
		"--user-data-dir",
		userDataDir,
		"--extensions-dir",
		join(userDataDir, "extensions"),
		"--disable-extensions",
		"--disable-workspace-trust",
		"--skip-release-notes",
	],
});
