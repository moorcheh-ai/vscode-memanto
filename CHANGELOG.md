# Changelog

## 0.2.0

- Works on Memanto Cloud. After `memanto login`, the window's private server stores and
  reads your memories on Memanto Cloud, shared with your other computers and tools. Needs
  a `memanto` release with Memanto Cloud support for `memanto serve`.
- Uses the agent active on this computer, the same one the CLI, coding tools and the desktop
  widget use, and follows it when you switch agents anywhere.
- **Memanto: Select agent** now activates the agent on this computer, like
  `memanto agent activate`.
- Removed the `memanto.agentId` setting. Switch agents with **Memanto: Select agent** or
  `memanto agent activate`.

## 0.1.1

- Use the same mascot for the marketplace icon and the readme logo.

## 0.1.0

First release.

- Chat sidebar with Recall and Answer modes, agent picker and type filters.
- Memories tree grouped by memory type.
- `@memanto` participant for Copilot Chat, with `/recall`, `/recent` and `/remember`.
- Three tools for Copilot agent mode: `memanto_recall` and `memanto_answer` run on their
  own, `memanto_remember` asks before saving.
- Commands for recall, asking a question, remembering a selection, and exporting memories.
- Runs a private Memanto server per window and stops it when the window closes.
- Joins an agent's existing session so the CLI and your coding agents stay signed in.
