"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.ServerManager = void 0;
const child_process_1 = require("child_process");
const fs_1 = require("fs");
const net_1 = require("net");
const os_1 = require("os");
const path_1 = require("path");
/** A cold `memanto serve` imports the whole app; allow it this long to answer. */
const STARTUP_TIMEOUT_MS = 45_000;
/** Fresh ports to try if another process grabs the one we picked first. */
const LAUNCH_ATTEMPTS = 3;
/**
 * Owns this window's private Memanto server.
 *
 * Ownership is tracked by pid rather than by ChildProcess handle, because on
 * Windows `memanto.exe` is a pip launcher that runs the real server as a child
 * `python.exe`. Killing only the launcher would orphan the server and leave the
 * port bound, so stopping always kills the whole process tree.
 */
class ServerManager {
    probe;
    log;
    ownedPid = null;
    ownedBaseUrl = null;
    pidFile;
    /**
     * @param instanceKey Distinguishes windows. Each window runs its own
     *   copy of the extension, and must not adopt or stop another window's server.
     */
    constructor(probe, log, instanceKey) {
        this.probe = probe;
        this.log = log;
        this.pidFile = (0, path_1.join)((0, os_1.tmpdir)(), `vscode-memanto-${instanceKey}.json`);
    }
    get baseUrl() {
        return this.ownedBaseUrl;
    }
    get pid() {
        return this.ownedPid;
    }
    /**
     * Make sure the private server is running, and return where it is.
     *
     * Reuses the server this vault already owns — including one a crashed
     * session left behind — before ever starting another.
     */
    async ensureDedicated(binaryPath) {
        if (this.ownedBaseUrl && this.ownedPid !== null && (await this.probe(this.ownedBaseUrl))) {
            return this.state(true, "The private Memanto server is running.");
        }
        if (this.ownedPid !== null) {
            // We had a server and it stopped answering. Clear it out properly
            // rather than stacking a second process beside a hung one.
            killTree(this.ownedPid);
            this.forget();
        }
        if (await this.adoptFromPreviousSession()) {
            return this.state(true, "Reconnected to the private server from the last session.");
        }
        if (!binaryPath) {
            return {
                running: false,
                baseUrl: "",
                pid: null,
                message: "Memanto is not installed, so the server cannot be started.",
            };
        }
        return this.launchOnFreePort(binaryPath);
    }
    async launchOnFreePort(binaryPath) {
        let lastError = "";
        for (let attempt = 0; attempt < LAUNCH_ATTEMPTS; attempt++) {
            let port;
            try {
                port = await freeLoopbackPort();
            }
            catch (error) {
                lastError = `no free port available (${error.message})`;
                break;
            }
            const baseUrl = `http://127.0.0.1:${port}`;
            const launched = this.launch(binaryPath, port);
            if (!launched) {
                lastError = "the memanto executable could not be launched";
                break;
            }
            const { child, exited, stderrTail } = launched;
            if (await this.waitForHealth(baseUrl, exited)) {
                this.ownedPid = child.pid ?? null;
                this.ownedBaseUrl = baseUrl;
                this.writePidFile();
                this.log(`Started private memanto serve at ${baseUrl} (pid ${child.pid}).`);
                return this.state(true, `Started a private Memanto server on port ${port}.`);
            }
            lastError = lastLine(stderrTail()) || (exited() ? "the server exited during startup" : "the server did not respond in time");
            if (child.pid)
                killTree(child.pid);
        }
        this.log(`memanto serve failed: ${lastError}`);
        return {
            running: false,
            baseUrl: "",
            pid: null,
            message: `Could not start the Memanto server: ${lastError}`,
        };
    }
    launch(binaryPath, port) {
        // Node refuses to spawn .cmd/.bat without a shell (CVE-2024-27980).
        const needsShell = /\.(cmd|bat)$/i.test(binaryPath);
        let child;
        try {
            child = (0, child_process_1.spawn)(needsShell ? `"${binaryPath}"` : binaryPath, 
            // Bind loopback explicitly: the CLI default can be 0.0.0.0, and the
            // server has no business being reachable from the network.
            ["serve", "--host", "127.0.0.1", "--port", String(port)], {
                shell: needsShell,
                windowsHide: true,
                stdio: ["ignore", "ignore", "pipe"],
                env: {
                    ...process.env,
                    // With no console attached, Python falls back to the ANSI code
                    // page on Windows and crashes printing Rich's unicode output.
                    PYTHONIOENCODING: "utf-8",
                    PYTHONUTF8: "1",
                    NO_COLOR: "1",
                },
            });
        }
        catch (error) {
            this.log(`Failed to launch memanto: ${error.message}`);
            return null;
        }
        let hasExited = false;
        let tail = "";
        child.on("exit", () => {
            hasExited = true;
        });
        child.on("error", (error) => {
            hasExited = true;
            tail += `\n${error.message}`;
        });
        // Keep draining stderr for the life of the process: uvicorn logs there,
        // and a full, unread pipe would eventually block the server.
        child.stderr?.on("data", (chunk) => {
            tail = (tail + chunk.toString()).slice(-4000);
        });
        return { child, exited: () => hasExited, stderrTail: () => tail };
    }
    /** Poll `/health` until it answers, the process dies, or we time out. */
    async waitForHealth(baseUrl, exited) {
        const deadline = Date.now() + STARTUP_TIMEOUT_MS;
        while (Date.now() < deadline) {
            await sleep(400);
            if (await this.probe(baseUrl))
                return true;
            if (exited())
                return false;
        }
        return false;
    }
    /**
     * Stop the private server. A server this extension did not start is never
     * touched, because we only ever hold the pid of one we launched.
     *
     * Synchronous on purpose: this also runs from `deactivate()` while the
     * window is closing, where an async kill may never get scheduled.
     */
    stop() {
        if (this.ownedPid === null)
            return;
        const pid = this.ownedPid;
        killTree(pid);
        this.log(`Stopped private memanto serve (pid ${pid}).`);
        this.forget();
    }
    forget() {
        this.ownedPid = null;
        this.ownedBaseUrl = null;
        try {
            if ((0, fs_1.existsSync)(this.pidFile))
                (0, fs_1.unlinkSync)(this.pidFile);
        }
        catch {
            // A stale record is re-validated before it is ever acted on.
        }
    }
    writePidFile() {
        try {
            (0, fs_1.writeFileSync)(this.pidFile, JSON.stringify({ pid: this.ownedPid, baseUrl: this.ownedBaseUrl }), "utf8");
        }
        catch {
            // Only needed to recover after a crash; not fatal if it cannot be written.
        }
    }
    /**
     * The window was killed before it could stop the server it started. If that
     * process is still ours and still answering, take it back so it is stopped
     * when this session ends; if it is alive but hung, kill it.
     */
    async adoptFromPreviousSession() {
        let record;
        try {
            if (!(0, fs_1.existsSync)(this.pidFile))
                return false;
            record = JSON.parse((0, fs_1.readFileSync)(this.pidFile, "utf8"));
        }
        catch {
            return false;
        }
        const { pid, baseUrl } = record;
        if (typeof pid !== "number" || typeof baseUrl !== "string" || !isMemantoProcess(pid)) {
            this.forget();
            return false;
        }
        if (await this.probe(baseUrl)) {
            this.ownedPid = pid;
            this.ownedBaseUrl = baseUrl;
            this.log(`Adopted private memanto serve from a previous session (pid ${pid}).`);
            return true;
        }
        killTree(pid);
        this.log(`Cleaned up an unresponsive private memanto serve (pid ${pid}).`);
        this.forget();
        return false;
    }
    state(running, message) {
        return { running, baseUrl: this.ownedBaseUrl ?? "", pid: this.ownedPid, message };
    }
}
exports.ServerManager = ServerManager;
/** Ask the OS for a free port on loopback. */
function freeLoopbackPort() {
    return new Promise((resolve, reject) => {
        const server = (0, net_1.createServer)();
        server.unref();
        server.on("error", reject);
        server.listen(0, "127.0.0.1", () => {
            const address = server.address();
            const port = typeof address === "object" && address ? address.port : 0;
            server.close(() => (port ? resolve(port) : reject(new Error("no port assigned"))));
        });
    });
}
/**
 * Confirm a pid still belongs to a Memanto server before acting on it. Pids are
 * recycled, and killing an unrelated process because a temp file said so would
 * be unforgivable.
 */
function isMemantoProcess(pid) {
    try {
        process.kill(pid, 0);
    }
    catch {
        return false;
    }
    try {
        if (process.platform === "win32") {
            const result = (0, child_process_1.spawnSync)("tasklist", ["/FI", `PID eq ${pid}`, "/FO", "CSV", "/NH"], {
                windowsHide: true,
                encoding: "utf8",
                timeout: 5000,
            });
            return /memanto|python/i.test(result.stdout ?? "");
        }
        const result = (0, child_process_1.spawnSync)("ps", ["-p", String(pid), "-o", "command="], {
            encoding: "utf8",
            timeout: 5000,
        });
        return /memanto/i.test(result.stdout ?? "");
    }
    catch {
        return false;
    }
}
/** Kill a process and everything it spawned. */
function killTree(pid) {
    try {
        if (process.platform === "win32") {
            (0, child_process_1.spawnSync)("taskkill", ["/PID", String(pid), "/T", "/F"], {
                windowsHide: true,
                timeout: 5000,
            });
        }
        else {
            process.kill(pid, "SIGTERM");
        }
    }
    catch {
        // Already gone.
    }
}
function lastLine(text) {
    const lines = text.trim().split(/\r?\n/).filter((line) => line.trim());
    return lines.length ? lines[lines.length - 1].trim() : "";
}
function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}
