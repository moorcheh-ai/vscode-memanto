import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import {
	normalizeBaseUrl,
	readActiveAgentId,
	readApiKey,
	readSessionToken,
} from "../src/env/detect";

describe("normalizeBaseUrl", () => {
	it("merges the host and port the CLI stores separately", () => {
		// The CLI writes `server.url: 127.0.0.1` and `server.port: 8000` as two
		// keys. Using the url alone yields port 80, where nothing serves Memanto.
		assert.equal(normalizeBaseUrl("127.0.0.1", 8000), "http://127.0.0.1:8000");
	});

	it("falls back to Memanto's default port", () => {
		assert.equal(normalizeBaseUrl("127.0.0.1", null), "http://127.0.0.1:8000");
	});

	it("connects to loopback when the config holds a bind address", () => {
		assert.equal(normalizeBaseUrl("0.0.0.0", 8000), "http://127.0.0.1:8000");
	});

	it("keeps an explicit port", () => {
		assert.equal(normalizeBaseUrl("http://127.0.0.1:9000", 8000), "http://127.0.0.1:9000");
	});

	it("leaves a remote host on its scheme's default port", () => {
		assert.equal(normalizeBaseUrl("https://memanto.example.com", 8000), "https://memanto.example.com");
	});

	it("strips trailing slashes and paths", () => {
		assert.equal(normalizeBaseUrl("http://127.0.0.1:8000/", 8000), "http://127.0.0.1:8000");
	});

	it("survives nonsense", () => {
		assert.equal(normalizeBaseUrl("http://", 8000), "http://127.0.0.1:8000");
	});
});

describe("reading Memanto's files", () => {
	const home = mkdtempSync(join(tmpdir(), "memanto-test-"));
	let previousProfile: string | undefined;
	let previousHome: string | undefined;
	let previousKey: string | undefined;

	before(() => {
		previousProfile = process.env.USERPROFILE;
		previousHome = process.env.HOME;
		previousKey = process.env.MOORCHEH_API_KEY;
		process.env.USERPROFILE = home;
		process.env.HOME = home;
		delete process.env.MOORCHEH_API_KEY;

		mkdirSync(join(home, ".memanto", "sessions"), { recursive: true });
		writeFileSync(
			join(home, ".memanto", ".env"),
			"# MEMANTO Environment\nMOORCHEH_API_KEY=abc123\nOTHER=zzz\n",
		);

		const future = new Date(Date.now() + 3_600_000).toISOString();
		const past = new Date(Date.now() - 3_600_000).toISOString();
		const write = (agent: string, body: Record<string, unknown>): void =>
			writeFileSync(join(home, ".memanto", "sessions", `${agent}.json`), JSON.stringify(body));

		write("live", { session_token: "tok-live", status: "active", expires_at: future });
		write("expired", { session_token: "tok-old", status: "active", expires_at: past });
		write("terminated", { session_token: "tok-dead", status: "terminated", expires_at: future });
	});

	after(() => {
		if (previousProfile === undefined) delete process.env.USERPROFILE;
		else process.env.USERPROFILE = previousProfile;
		if (previousHome === undefined) delete process.env.HOME;
		else process.env.HOME = previousHome;
		if (previousKey !== undefined) process.env.MOORCHEH_API_KEY = previousKey;
	});

	it("reads the API key out of ~/.memanto/.env", () => {
		assert.equal(readApiKey(), "abc123");
	});

	it("joins a live session rather than starting one", () => {
		assert.equal(readSessionToken("live"), "tok-live");
	});

	it("ignores an expired session", () => {
		assert.equal(readSessionToken("expired"), null);
	});

	it("ignores a session that is not active", () => {
		assert.equal(readSessionToken("terminated"), null);
	});

	it("returns null for an agent with no session", () => {
		assert.equal(readSessionToken("missing"), null);
	});

	it("refuses agent ids that could escape the sessions directory", () => {
		assert.equal(readSessionToken("../../.env"), null);
		assert.equal(readSessionToken("a/b"), null);
	});

	describe("the agent active on this computer", () => {
		const marker = (): string => join(home, ".memanto", "sessions", "active");
		const config = join(home, ".memanto", "config.yaml");

		it("is null when no agent is active", () => {
			rmSync(marker(), { force: true });
			assert.equal(readActiveAgentId(), null);
		});

		it("reads the plain-file marker the CLI writes where symlinks fail", () => {
			writeFileSync(marker(), "live\n");
			assert.equal(readActiveAgentId(), "live");
		});

		it("reads the symlink marker", (t) => {
			rmSync(marker(), { force: true });
			try {
				symlinkSync("live.json", marker());
			} catch {
				t.skip("symlinks need extra rights on this machine");
				return;
			}
			assert.equal(readActiveAgentId(), "live");
			rmSync(marker(), { force: true });
		});

		it("refuses a marker that is not a safe agent id", () => {
			writeFileSync(marker(), "../../.env");
			assert.equal(readActiveAgentId(), null);
		});

		it("reads on-prem's own sessions directory", () => {
			writeFileSync(marker(), "live");
			mkdirSync(join(home, ".memanto", "on-prem", "sessions"), { recursive: true });
			writeFileSync(join(home, ".memanto", "on-prem", "sessions", "active"), "local-agent");
			writeFileSync(config, "memanto:\n  backend: on-prem\n");
			try {
				assert.equal(readActiveAgentId(), "local-agent");
			} finally {
				rmSync(config, { force: true });
			}
			assert.equal(readActiveAgentId(), "live");
		});
	});
});
