# Working on Joblin

This is for anyone changing Joblin's code. If you only want to use Joblin, see the [README](README.md).

Joblin is a single Node.js process. It serves a dashboard on `http://localhost:4321`, runs two background workers (one finds jobs, one applies), and drives a real Chrome window that it hides on macOS. There is no build step: the backend is plain ES modules and the frontend is one HTML page with vanilla JavaScript.

## Run it

```bash
npm install
npx playwright install chromium      # fallback browser; Google Chrome is used when installed
ollama pull qwen2.5:3b               # or set an API key in Settings → AI model
npm run background                   # dashboard at http://localhost:4321, no app window
npm test                             # unit tests (uses a throwaway data folder)
npm run check                        # syntax-checks every JS file
```

Set `JOBLIN_HOME=/some/folder` to keep a second copy of your settings, database and browser profile somewhere else. The tests do this, so they never touch real data. `JOBERT_DEBUG=1` prints what the form filler sees and decides.

## How a job flows through Joblin

```
find ──▶ queued ──▶ prepare ──▶ pending_approval ──▶ approved ──▶ apply ──▶ submitted
                                (Review batch)        (you, or     │
                                                      autopilot)   ├─▶ needs_review (a question for you, an emailed code, a form error)
                                                                   └─▶ manual (a site Joblin can't submit to)
```

1. **Find** (`src/search/`)
   - `boards.js` reads public Greenhouse, Lever and Ashby job boards. Titles are matched by field: a "finance" search accepts "Investment Analyst" too.
   - `linkedin.js` reads LinkedIn results. It reads each job from LinkedIn's public job page (no browser) and finds the same job on the company's own board.
   - Searches take turns by field. Fields the user recently asked the chat about go first.
2. **Prepare** (`src/apply/documents.js`, `src/apply/cover.js`)
   - Picks the best resume type and reorders bullet points (never invents anything).
   - Writes a cover letter: a template for most jobs, a precise rewrite for high-fit ones.
   - Renders both to PDF. Two jobs are prepared at a time.
3. **Review**
   - The user approves jobs on the Review batch page, or autopilot approves them.
4. **Apply** (`src/apply/apply.js`)
   - Opens the application in the hidden Chrome window (`src/apply/browser.js`) and fills every field.
   - Questions are answered in this order: the user's saved answers, then profile rules (`RULES`, `contextRule`), then the model.
   - Unanswerable questions park the job, and it requeues itself when the user answers.
   - Security codes are read from Gmail (`src/email/inbox.js`, `src/email/gmailWeb.js`).
5. **Outreach** (`src/email/`)
   - After applying, emails go to the people who posted the job, as a drip in business hours.
   - Replies, interviews and rejections are read from the inbox.

The workers, the scheduler and the stop/pause flags live in `start.js`. The dashboard API is `src/server.js`. The UI is `public/app.js`: one file, with one `VIEWS.<page>` function per page and one `SETTINGS.<tab>` function per settings tab.

## Where things live

| Folder | What's in it |
|---|---|
| `src/core/` | `config.js` (settings, `.env`, paths), `db.js` (SQLite tables), `llm.js` (Ollama, Claude, OpenAI, Gemini) |
| `src/you/` | `profile.js` (roles from resumes, nearest base, role order), `memory.js` (saved answers, notes), `tracks.js` (resume types), `resumeImport.js` |
| `src/search/` | `boards.js`, `linkedin.js`, `chat.js` (the chat assistant) |
| `src/apply/` | `apply.js` (form filling and submitting), `browser.js` (the hidden Chrome), `documents.js`, `cover.js` |
| `src/email/` | `mailer.js` (sending), `inbox.js` (reading, codes), `gmailWeb.js` (Gmail sign-in in Joblin's browser), `contacts.js`, `people.js` |
| `public/` | The dashboard: `index.html`, `app.js`, `app.css`, images |
| `tests/` | `npm test` |
| `templates/`, `resumes/` | Cover letter and email templates, resume content. The user's own copies are git-ignored; `examples/` ships with the repo. |

## Data

- **Settings:** `config.json`, created from `config.example.json` on first run. When you add a setting, add its default to `config.example.json`; existing installs pick it up automatically.
- **Secrets:** Gmail and API keys live in `.env`. They are never sent to the browser.
- **Database:** SQLite at `data/jobert.db`. Main tables:
  - `jobs`: one row per posting.
  - `applications`: status, documents, fit score and notes for each job.
  - `answers` and `answer_waits`: saved questions, and which jobs are waiting on which question.
  - `contacts`, `emails`: outreach.
  - `facts`: memory notes.
  - `events`: the activity log.
  - `kv`: small state.
  - `linkedin_seen`: jobs already passed over.

  Tables are created and migrated in the module that owns them (`CREATE TABLE IF NOT EXISTS …`).
- **Per-job documents:** `data/output/<job>/` holds the resume, cover letter and confirmation screenshot for each job.

## Things that will surprise you

- **One Chrome profile, one Chrome.**
  - Searching and applying share the hidden browser. `getContext()` serialises launches.
  - Each worker uses its own tab (`workPage(ctx, role)`). Avoid opening new tabs or windows: on macOS they bring Chrome to the front. A watchdog in `browser.js` hides it again within a second.
- **Headless Chrome is blocked** by Greenhouse's reCAPTCHA. That's why applications use a real Chrome window that Joblin hides.
- **Greenhouse forms** are opened through the embed URL (`job-boards.greenhouse.io/embed/job_app?for=…&token=…`), because many companies redirect their own careers pages.
- **LinkedIn rate-limits** its public job pages after about 10 quick requests. `readJobFast` paces requests and waits instead of falling back to Chrome.
- **The model never guesses facts.**
  - Questions matching `FACTUAL` in `apply.js` (dates, numbers, IDs) go to the user.
  - Skill questions (`SKILL_Q`) are answered "yes" using the user's real roles.
  - Long written answers are written fresh for every job and never saved.
- **Autosave.** Settings tabs save themselves: `autosave()` in `app.js` clicks the tab's own save button after a change. New settings tabs get this for free if they have a `button.btn.primary[id^="save"]`.

## Conventions

- Plain JavaScript (ES modules, Node 20+), no build, no framework. Keep it that way so anyone can open a file and change it.
- Comments explain *why*, in plain words. User-facing text is short, friendly and concrete.
- Add a test in `tests/joblin.test.mjs` for any rule that decides what goes into an application.
