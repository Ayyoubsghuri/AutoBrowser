# AutoBrowser

A desktop browser (Windows `.exe`) that **learns automations from your clicks**.
Open a website, press **Record**, use the site normally, then save it as a flow.
Replay it exactly with no AI, or let Claude turn it into a smarter automation
(loops over table rows, pagination, login, variables) from the tips you leave on each step.

```
┌──────────────── Electron shell (.exe) ─────────────────┐
│  Next.js UI (glass chrome, recorder, flows, accounts)  │
│  Tabs = real Chromium pages, one isolated profile      │
│  per account (cookies & logins persist)                │
│  Recorder + replay engine (trusted human-like input)   │
└──────────────┬─────────────────────────────────────────┘
               │ localhost + secret token
┌──────────────▼──────────────┐
│ FastAPI backend (bundled)   │  SQLite: flows, runs, accounts
│ Encrypted vault (Fernet)    │  passwords, 2FA secrets, API key
│ AI: Claude / OpenAI / NVIDIA│  optional
│ steps / self-healing        │
└─────────────────────────────┘
```

## Using it

1. **Accounts** (person icon): create one account profile per login you want to automate. Each one is
   a separate browser profile with its own cookies. Add a saved login (site, username, password, optional
   2FA secret); everything is encrypted on your machine. You can also just open a tab as that account and log in by hand once.
   The session is kept.
2. **Record**: open the site, press **Record**, then click and type as usual. Each action becomes a step:
   - email/username fields become `{{account.username}}`, passwords `{{account.password}}`, 2FA fields `{{account.totp}}`.
     Real secrets are never stored in a flow.
   - **Pick table** grabs a whole table or repeated list (rows and columns). **Pick text** grabs one value.
   - **Wait for…**, **Pause**, **AI step** and **Log in with saved account** add steps by hand.
3. **Tips**: every step has a *Tip for AI* box. Leave it **empty** to repeat exactly what you did.
   Write a tip when you mean something more general: *"do this for every row"*, *"keep clicking next until the last page"*,
   *"pick the newest order"*, *"type today's date"*.
4. **Save** or **Save & build with AI**. Then, under **Flows**, pick the accounts to run as and a mode:

| Mode | What runs | Needs an AI key |
|---|---|---|
| **Exact** | your recording, step by step | no |
| **AI assist** | your recording; steps with a tip are done by the AI agent; broken selectors are re-found by AI | yes |
| **AI-built** | the flow Claude built from your recording and tips (loops, login, pagination, variables) | only for its `ai` steps |

Results (tables, text) are listed under **Runs** and can be exported as CSV or JSON.

### Filling websites from Excel, CSV or PDFs
1. **Data** (spreadsheet icon) → **Import** an `.xlsx`, `.xls` or `.csv` (pick the sheet and header row), or several **PDFs**:
   each PDF becomes one row. Fields come from fillable PDF form fields, or from rules you set: *after label*
   ("File number") or a regex. **Suggest rules** asks the AI; in private mode it only sees the labels shared by all
   your PDFs. Everything else stays local.
2. **Recorder** → *Data* → choose the file. Record one entry by hand using row 1. Values you type that match the row
   become `{{row.Column}}` automatically, and you can also pick a column on any step. Checkboxes are recorded as
   **set on / off** steps and can follow a column (yes / x / 1 / true / oui = ticked).
3. Steps before **"Repeats for each data row from here"** (e.g. logging in) run once; the rest run for every row.
   Move the marker with ↻ on a step.
4. **Flows → your flow → Data**: **link another file** by a shared column (like VLOOKUP), so a second Excel adds
   columns to the first. You can also filter rows (e.g. only where *Status* is empty), set a start row or maximum, and
   choose whether to stop at the first error.
5. **Run**: progress shows per row. Under **Runs** → **Excel**, you get your rows back with `_status`, `_message` and
   any values extracted per row (e.g. the confirmation number the site showed).

### AI providers
Pick one in **Settings → AI**; each keeps its own encrypted key and model:

| Provider | Key from | Default model | Notes |
|---|---|---|---|
| **Claude** (Anthropic) | console.anthropic.com | `claude-opus-5-5` | strict JSON output, screenshots |
| **OpenAI** | platform.openai.com | `gpt-5` | strict JSON output, screenshots; optional server URL for any OpenAI-compatible API (OpenRouter, Ollama, LM Studio…) |
| **NVIDIA** | build.nvidia.com | `meta/llama-3.3-70b-instruct` | hosted NIM models; screenshots only sent to vision models; weaker models may fail on large flows |

You can type any model id your account can use.

### Private mode (on by default): the AI reads the code, never the data
For government, banking, health or any personal data. With **Settings → Private mode** on:

- While recording, each page is saved as a **code outline**: HTML structure, ids, classes, field names,
  labels, column headers and button captions. Every data value is masked by its shape:
  `John Smith 2024-05-01` → `Xxxx Xxxxx 9999-99-99`, `$1,250.00` → `$9,999.99`. Long lists collapse to
  "… 47 more rows like the ones above".
- **Build with AI** sends only that outline and your steps with values masked, URL parameters
  removed (`?id=…`) and text-based selectors dropped. The AI builds loops, pagination and extraction from the
  structure; the real selectors and values are **put back on your computer** after it answers.
- **During runs**, AI steps get the masked outline instead of the page text, **no screenshots**, and
  `{{row.x}}` placeholders instead of real row values (filled in locally when typing).
- **Preview what the AI will see** on the Build with AI screen shows the exact text that would be sent.
- Passwords and 2FA codes are never sent in any mode. Your own goal text is sent as written, so don't paste data into it.

For zero data leaving the machine at all, combine private mode with a local model (OpenAI provider +
`http://localhost:11434/v1` for Ollama), or skip AI and run flows in **Exact** mode.

### Templates you can use in values
`{{account.username}}` `{{account.password}}` `{{account.totp}}` `{{today}}` `{{now}}` `{{row.<column>}}` (inside a row loop) `{{vars.<name>}}` (results of earlier extract steps)

## Browser engine: built-in Chromium or Firefox

AutoBrowser's own tabs are Chromium (Electron can only embed Chromium). You can also use **Firefox**:

- **Settings → Browser engine → Install Firefox engine** downloads Playwright's Firefox build (~95 MB) once.
- Pick Firefox as the **default** for new tabs, or per account (**Accounts → Browser**). Each Firefox account keeps
  its own profile, logins and cookies.
- Firefox opens in **its own window** next to AutoBrowser. The tab bar shows it with an `FF` badge, and
  **Show Firefox window** brings it forward. Recording, Pick table/text, runs, Excel/PDF data, AI steps and private mode
  all work the same as with the built-in browser.
- Sites see a normal Firefox: real Firefox user agent and `navigator.webdriver === false`.

## Staying under the radar

What AutoBrowser does so sites see an ordinary Chrome:

- Chrome user agent **and** matching client hints (`Sec-CH-UA*`, `navigator.userAgentData`) for the Chromium version it ships.
- `navigator.webdriver === false`, `window.chrome` present, notification permission consistent; patched functions report `[native code]`.
- **No DevTools protocol and no webdriver** during runs: clicks and keys go through Chromium's native input path, so events are
  `isTrusted`. Mouse paths are curved, click points vary, and typing has natural rhythm; the **speed** is adjustable in Settings.
- Recorder and replay code runs in an **isolated world** that page scripts can't see.
- One persistent profile per account, with optional per-account **proxy** (`http://user:pass@host:port`, `socks5://…`).

No automation tool is undetectable. Sites with strong bot protection, CAPTCHAs or behavioural scoring can still notice it.
Use it on accounts you own and within each site's terms.

## Development

Requirements: Node 20+, Python 3.11+.

```bash
npm install            # root helpers (concurrently, wait-on)
npm run setup          # installs frontend + desktop + backend deps
npm run dev            # Next.js dev server + Electron (backend starts automatically)
npm test               # backend unit tests
npm run test:e2e       # builds the UI, launches the real app, records + replays on a demo site
```

In dev the Electron app starts the backend with your system `python` (or `backend/.venv` if present).

## Building the Windows .exe

On Windows (PowerShell):

```powershell
./scripts/build-windows.ps1
```

This produces `desktop/release/AutoBrowser Setup <version>.exe` (installer) and
`desktop/release/AutoBrowser-<version>-portable.exe`. The GitHub Actions workflow
`.github/workflows/build.yml` runs the tests and builds both executables on every push (download them from the run's artifacts).

## Layout

```
backend/    FastAPI app (flows, runs, accounts vault, Claude integration), PyInstaller spec, tests
frontend/   Next.js UI (static export, loaded by Electron from app://autobrowser)
desktop/    Electron main process, page preload (stealth + recorder + DOM engine), replay runner
scripts/    build-windows.ps1
```

Data lives in `%APPDATA%\AutoBrowser\data` (database, vault key). Browser profiles live in Electron's userData folder.
