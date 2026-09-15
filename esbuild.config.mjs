import esbuild from "esbuild";
import process from "process";

const production = process.argv.includes("--production");
const watch = process.argv.includes("--watch");

/** The extension runs in VS Code's Node host; `vscode` is provided at runtime. */
const extensionConfig = {
	entryPoints: ["src/extension.ts"],
	bundle: true,
	format: "cjs",
	platform: "node",
	target: "node18",
	external: ["vscode"],
	outfile: "dist/extension.js",
	sourcemap: !production,
	minify: production,
	logLevel: "info",
};

/** The webview runs in a sandboxed browser context with no Node APIs. */
const webviewConfig = {
	entryPoints: ["src/webview/main.ts"],
	bundle: true,
	format: "iife",
	platform: "browser",
	target: "es2020",
	outfile: "dist/webview.js",
	sourcemap: !production,
	minify: production,
	logLevel: "info",
};

if (watch) {
	const contexts = await Promise.all([
		esbuild.context(extensionConfig),
		esbuild.context(webviewConfig),
	]);
	await Promise.all(contexts.map((context) => context.watch()));
} else {
	await Promise.all([esbuild.build(extensionConfig), esbuild.build(webviewConfig)]);
}
