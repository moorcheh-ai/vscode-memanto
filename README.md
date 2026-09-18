<p align="center">
  <img src="resources/logo.svg" alt="Memanto" width="440">
</p>

# Memanto for VS Code

Search and ask questions about your agents' memory without leaving the editor.

[Memanto](https://github.com/moorcheh-ai/memanto) stores what your coding agents learn
(decisions, preferences, facts and mistakes) from tools like Claude Code, Cursor and Codex.
This extension puts that memory in the sidebar, so you can look things up while you work and
save new ones straight from your code.

## Features

**Chat sidebar.** Pick an agent, then choose a mode:

- **Recall** lists matching memories with their type, confidence, provenance and date.
  You can also list the most recent memories, memories as of a date, or what changed since
  a date.
- **Answer** writes a reply based on the stored memories.

Any result can be copied, inserted into the file you're editing, or opened as its own tab.

**Memories tree.** Browse an agent's memories grouped by type. Memories load when you expand
a type, so opening the view stays fast.

**Remember a selection.** Select code or text, right click, and choose **Memanto: Remember
selection** to save it with a type you pick. Your other agents can recall it afterwards.

**Export.** Write an agent's memories into a folder as Markdown with frontmatter, using
Memanto's Open Knowledge Format.

## Using Memanto with Copilot

If you have GitHub Copilot Chat, Memanto plugs into it in two ways. Neither is required:
the sidebar works on its own, and on a VS Code without these APIs the extension skips them.

**Ask it directly with `@memanto`.** In the chat panel:

```
@memanto what did we decide about authentication?
@memanto /recall database
@memanto /recent
@memanto /remember we dropped session cookies
```

Answers come from your stored memories, and each memory is a link that opens as a tab.

**Let Copilot look things up itself.** The extension registers three tools that Copilot's
agent mode can call on its own:

| Tool | What it does | Confirmation |
| --- | --- | --- |
| `memanto_recall` | Searches your memories and returns the matches | Runs on its own |
| `memanto_answer` | Asks Memanto a question and returns a written answer | Runs on its own |
| `memanto_remember` | Saves one memory | Asks you first |

`memanto_recall` returns the raw memories as evidence. `memanto_answer` pulls several
memories together into one answer, which is better for "why did we do it this way", and is
slower because it runs a model over them.

So when you ask Copilot to add a feature, it can check what your team already decided and
write code that matches, without you looking anything up. You can also point at the tools
explicitly with `#memanto`, `#memantoAsk` or `#memantoRemember` in a prompt.

Saving asks for confirmation on purpose. Memories are shared with every agent using that
Memanto agent, so a model should not fill that estate on its own judgement.

## Requirements

- **VS Code 1.95** or newer.
- **[Memanto](https://github.com/moorcheh-ai/memanto)**, which needs Python 3.11 or newer.

## Setup

The extension installs nothing. It checks what's already on your machine and shows the
commands for anything missing, each of which you can copy. Run **Memanto: Setup steps** from
the command palette at any time.

If Memanto is already set up, there's nothing to configure. The extension reads your API key
from `~/.memanto/.env` and your active agent from `~/.memanto/config.yaml`.

To start from scratch, run two commands:

```bash
pip install memanto          # or: uv tool install memanto / pipx install memanto
memanto                      # choose a backend and enter your key
```

The cloud backend needs a free key from
[console.moorcheh.ai/api-keys](https://console.moorcheh.ai/api-keys) (100,000 operations, no
card required). The on-prem backend needs no key and runs locally through Docker.

## Commands

| Command | What it does |
| --- | --- |
| **Memanto: Open chat** | Opens the chat sidebar. |
| **Memanto: Recall memories** | Searches memories and lists the matches. |
| **Memanto: Ask a question** | Asks a question and opens the answer in a tab. |
| **Memanto: Remember selection** | Saves the selected text as a memory. |
| **Memanto: Select agent** | Chooses which agent this window uses. |
| **Memanto: Export memories to a folder** | Writes memories to a folder as Markdown. |
| **Memanto: Start server** / **Stop server** | Controls this window's private server. |
| **Memanto: Setup steps** | Shows the install steps with copyable commands. |

## Settings

| Setting | Default | What it does |
| --- | --- | --- |
| `memanto.agentId` | follows the CLI | Agent this window uses. |
| `memanto.server.mode` | `private` | Run a private server, or connect to your own. |
| `memanto.server.startOnStartup` | `false` | Start the server when the window opens instead of on first use. |
| `memanto.server.address` | follows the CLI | Address of your own server, for `attach` mode. |
| `memanto.recallLimit` | `10` | How many memories a recall returns. |
| `memanto.citeOnInsert` | `true` | Add a comment with type, provenance and date when inserting. |

## Network use and privacy

The extension only connects to a Memanto server on your own machine at `127.0.0.1`.

That server connects to [Moorcheh](https://www.moorcheh.ai) only if you chose the cloud
backend, in which case your memories are stored there. With the on-prem backend, nothing
leaves your machine. Run `memanto config show` to check which backend you're using.

Your API key is read from `~/.memanto/.env` and is never written into your workspace or
settings. It stays in the extension host and never reaches the sidebar webview.

Nothing is sent to Memanto unless you ask for it: what you type into the chat, and any text
you explicitly choose to remember.

## The server

The first time you use Memanto in a window, the extension starts its own `memanto serve` on
a free port using the `memanto` executable on your PATH, and stops it when the window closes.
If you run `memanto serve` yourself on any port, the extension doesn't use or stop it.

Each window gets its own server. If VS Code exits without stopping one, the next window using
the same folder reuses that server instead of starting another.

To use a server you run yourself, set `memanto.server.mode` to `attach`. The extension then
uses the address in `~/.memanto/config.yaml`, or `memanto.server.address` if you set one.

### Sessions

Memanto allows one session per agent. Starting a new session signs out every other client
using that agent, including the CLI and your coding agents. To avoid this, the extension
reuses the agent's current session and only starts a new one when the agent doesn't have one.

## Building from source

```bash
npm install
npm run build      # typechecks, then bundles into dist/
npm run watch      # rebuilds on every change
npm run package    # creates a .vsix
```

Press `F5` in VS Code to launch a window with the extension loaded.

## Licence

MIT. See [LICENSE](LICENSE).
