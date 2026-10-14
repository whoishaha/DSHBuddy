# DSHBuddy 🐋

[English](README.md) | [简体中文](README.zh-CN.md)

DSHBuddy is a companion pet plugin for DeepSeek Harness (DSH). A desktop whale reflects your DSH session in real time and keeps you company while you work.

The Node host listens to DSH session events; the browser client renders the pet, speech bubbles, focus tools, and growth features in the DSH Web UI. It runs entirely as a plugin, with no separate desktop app or sidecar. Companion data stays on your computer under `~/.petdex/` by default.

## ✨ Features

- **Two display modes:** Keep the pet in a draggable corner position or let it roam along the bottom of the page. Its position is remembered.
- **Live session reactions:** Nine sprite states respond to messages, tool calls, approvals, questions, completion, and errors. Agent-registry polling backs up event delivery when necessary.
- **Thoughtful alerts:** Optional system sounds for completion, approval requests, and errors; low-frequency encouragement and break reminders; an idle sleep animation that ends when you approach the pet.
- **Growth and achievements:** Earn XP, develop a bond, track mood and energy, and review work patterns. Twenty-one achievement tracks contain 37 levels based on real usage. Growth stages, coins, and rebirth add long-term progression.
- **Pet shop and adoption:** Spend earned coins on snacks, toys, and permanent accessories. Browse, install, and switch pets from the Petdex community market; adoption reveals common, rare, epic, and occasional shiny variants.
- **Personality and conversation:** Adjust five personality traits. Chat through the host using DSH's configured model or compatible Ollama, OpenAI, and Gemini endpoints. Local conversations persist between sessions.
- **Focus and planning:** Use a Pomodoro timer, scheduled work orders, custom slash commands, a task list, and a notes calendar. Completed tasks can appear on the calendar, and calendar entries can become tasks.
- **Companion moments:** Pet the whale to build affinity, receive a once-a-day morning briefing, and choose which proactive care messages are allowed. Quiet hours and per-message limits keep interruptions restrained.
- **Work insights:** Review activity, focus time, rhythm, tool use, and milestones. Export statistics as CSV. Daily and weekly summaries can use an LLM, with offline templates as a fallback.
- **Personalization:** Choose a pet, adjust its size and display mode, and configure reminders and sounds. The DSH settings panel supports light and dark styles plus Chinese and English.

## 📦 Install from GitHub

Requirements: [DeepSeek Harness](https://github.com/deepseek-ai) with a working `dsh` command, Node.js 18 or newer, and npm.

Copy the HTTPS clone URL from this repository's **Code** menu, clone it, and enter the project directory. Then run:

```bash
npm ci
npm run build

# Replace this example with the absolute path to your project directory.
dsh plugin --profile web add "/absolute/path/to/dshbuddy"
```

Restart `dsh web` and refresh the page. The whale should appear in a corner, and DSH settings should show a DSHBuddy entry. DSH messages, tool calls, and approval requests will drive its animations and speech bubbles.

To update a source installation:

```bash
git pull && npm ci && npm run build
# Restart dsh web after rebuilding.
```

To check the offline suites and a running local installation:

```bash
npm test
node scripts/verify-live.mjs
```

## ⌨️ Quick controls

| Action | Result |
|---|---|
| Click the pet | Open its menu for panels, pet switching, size, display mode, settings, and visibility |
| Drag the pet | Move it; the position is saved |
| Double-click the pet | Open settings |
| Esc | Close the current menu or floating panel |

## 🗂 Local data

Data is stored under `~/.petdex/` by default, outside the plugin's source or installation directory. Set `DSHBUDDY_DATA_DIR` to use another local directory. DSHBuddy does not upload this local data.

```text
~/.petdex/
├── active.json              # Selected pet
├── pets/<slug>/             # Pet metadata and sprite sheet
└── runtime/
    ├── dshbuddy.json        # Plugin preferences
    ├── stats.json           # Session statistics
    ├── growth.json career.json memory.json profile.json
    └── chats.json notes.json calendar.json buddy-memory.json
```

## 🧩 Architecture

The host half (`src/host/`) runs in Node, listens to DSH session events, manages local state, and exposes same-origin endpoints under `/api/dshbuddy/`. The browser half (`src/client/`) renders the pet overlay and the DSHBuddy settings section as a React bundle.

## 🛠 Development

```bash
npm run build:dev   # Build with source maps
npm run typecheck   # TypeScript checks
npm test            # Offline host API and client bundle checks
```

The default whale in `assets/whale/` uses a generated placeholder sprite sheet that can be replaced with finished artwork.

## 📝 Changelog

### v0.1.0 · First public release

- A DSH-aware companion pet with corner and roaming modes, live status reactions, sounds, and proactive care.
- A unified growth profile with work insights, 21 achievement tracks and 37 levels, coins, accessories, evolution, and rebirth.
- Pomodoro focus, work orders, slash commands, tasks, notes calendar, and local statistics.
- Chinese and English UI, personality controls, local data storage, and direct Petdex community pet integration.
- TypeScript checks, offline integration tests, and GitHub Actions for Windows and Ubuntu.

## 🙏 Acknowledgements

Special thanks to [Petdex](https://github.com/crafter-station/petdex) for its pet platform and community ecosystem. DSHBuddy integrates directly with Petdex so users can browse, install, and switch community pets from within the plugin.

## 📄 License

[MIT](./LICENSE)
