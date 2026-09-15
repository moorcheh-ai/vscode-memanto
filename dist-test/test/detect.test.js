"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const strict_1 = __importDefault(require("node:assert/strict"));
const node_fs_1 = require("node:fs");
const node_os_1 = require("node:os");
const node_path_1 = require("node:path");
const node_test_1 = require("node:test");
const detect_1 = require("../src/env/detect");
(0, node_test_1.describe)("normalizeBaseUrl", () => {
    (0, node_test_1.it)("merges the host and port the CLI stores separately", () => {
        // The CLI writes `server.url: 127.0.0.1` and `server.port: 8000` as two
        // keys. Using the url alone yields port 80, where nothing serves Memanto.
        strict_1.default.equal((0, detect_1.normalizeBaseUrl)("127.0.0.1", 8000), "http://127.0.0.1:8000");
    });
    (0, node_test_1.it)("falls back to Memanto's default port", () => {
        strict_1.default.equal((0, detect_1.normalizeBaseUrl)("127.0.0.1", null), "http://127.0.0.1:8000");
    });
    (0, node_test_1.it)("connects to loopback when the config holds a bind address", () => {
        strict_1.default.equal((0, detect_1.normalizeBaseUrl)("0.0.0.0", 8000), "http://127.0.0.1:8000");
    });
    (0, node_test_1.it)("keeps an explicit port", () => {
        strict_1.default.equal((0, detect_1.normalizeBaseUrl)("http://127.0.0.1:9000", 8000), "http://127.0.0.1:9000");
    });
    (0, node_test_1.it)("leaves a remote host on its scheme's default port", () => {
        strict_1.default.equal((0, detect_1.normalizeBaseUrl)("https://memanto.example.com", 8000), "https://memanto.example.com");
    });
    (0, node_test_1.it)("strips trailing slashes and paths", () => {
        strict_1.default.equal((0, detect_1.normalizeBaseUrl)("http://127.0.0.1:8000/", 8000), "http://127.0.0.1:8000");
    });
    (0, node_test_1.it)("survives nonsense", () => {
        strict_1.default.equal((0, detect_1.normalizeBaseUrl)("http://", 8000), "http://127.0.0.1:8000");
    });
});
(0, node_test_1.describe)("reading Memanto's files", () => {
    const home = (0, node_fs_1.mkdtempSync)((0, node_path_1.join)((0, node_os_1.tmpdir)(), "memanto-test-"));
    let previousProfile;
    let previousHome;
    let previousKey;
    (0, node_test_1.before)(() => {
        previousProfile = process.env.USERPROFILE;
        previousHome = process.env.HOME;
        previousKey = process.env.MOORCHEH_API_KEY;
        process.env.USERPROFILE = home;
        process.env.HOME = home;
        delete process.env.MOORCHEH_API_KEY;
        (0, node_fs_1.mkdirSync)((0, node_path_1.join)(home, ".memanto", "sessions"), { recursive: true });
        (0, node_fs_1.writeFileSync)((0, node_path_1.join)(home, ".memanto", ".env"), "# MEMANTO Environment\nMOORCHEH_API_KEY=abc123\nOTHER=zzz\n");
        const future = new Date(Date.now() + 3_600_000).toISOString();
        const past = new Date(Date.now() - 3_600_000).toISOString();
        const write = (agent, body) => (0, node_fs_1.writeFileSync)((0, node_path_1.join)(home, ".memanto", "sessions", `${agent}.json`), JSON.stringify(body));
        write("live", { session_token: "tok-live", status: "active", expires_at: future });
        write("expired", { session_token: "tok-old", status: "active", expires_at: past });
        write("terminated", { session_token: "tok-dead", status: "terminated", expires_at: future });
    });
    (0, node_test_1.after)(() => {
        if (previousProfile === undefined)
            delete process.env.USERPROFILE;
        else
            process.env.USERPROFILE = previousProfile;
        if (previousHome === undefined)
            delete process.env.HOME;
        else
            process.env.HOME = previousHome;
        if (previousKey !== undefined)
            process.env.MOORCHEH_API_KEY = previousKey;
    });
    (0, node_test_1.it)("reads the API key out of ~/.memanto/.env", () => {
        strict_1.default.equal((0, detect_1.readApiKey)(), "abc123");
    });
    (0, node_test_1.it)("joins a live session rather than starting one", () => {
        strict_1.default.equal((0, detect_1.readSessionToken)("live"), "tok-live");
    });
    (0, node_test_1.it)("ignores an expired session", () => {
        strict_1.default.equal((0, detect_1.readSessionToken)("expired"), null);
    });
    (0, node_test_1.it)("ignores a session that is not active", () => {
        strict_1.default.equal((0, detect_1.readSessionToken)("terminated"), null);
    });
    (0, node_test_1.it)("returns null for an agent with no session", () => {
        strict_1.default.equal((0, detect_1.readSessionToken)("missing"), null);
    });
    (0, node_test_1.it)("refuses agent ids that could escape the sessions directory", () => {
        strict_1.default.equal((0, detect_1.readSessionToken)("../../.env"), null);
        strict_1.default.equal((0, detect_1.readSessionToken)("a/b"), null);
    });
});
