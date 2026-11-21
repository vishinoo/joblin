<div align="center">

<!-- 🖼️ IMAGE SLOT: docs/images/joblin-hero.png — Joblin waving hello in his little suit -->
<img src="docs/images/joblin-hero.png" alt="Joblin the goblin waving" width="260">

# Joblin

**An office goblin who applies for jobs so you don't have to.**

Joblin hunts down openings, reads every posting, writes you a tailored resume and cover letter, fills out the application on the company's own site, and emails the people doing the hiring.

It runs on your own computer. With [Ollama](https://ollama.com) it's **free, private, and needs no API keys.**

⭐ **If Joblin saves you an afternoon of copy-pasting, star the repo so other job hunters can find him.** ⭐

</div>

---

## Hello. I am Joblin.

I live in your computer. I wear a suit. I have read more job postings than any creature alive, and I have opinions about all of them.

You tell me what jobs you want. I go out into the job boards and come back with a sack full of openings. For each one I:

1. **Read the posting.** I work out the four things they actually care about, what the company does, and how formal to sound.
2. **Tailor your resume.** I pick your strongest real bullet points for that job. Real ones only. I don't make things up.
3. **Write the cover letter.** I draft a few openings, score them, throw out the clichés, and keep the best one.
4. **Fill in the application** on Greenhouse, Lever or Ashby. Every question you answer gets remembered, so I never ask twice.
5. **Email the humans.** I find who's hiring and send a polite note during business hours, then follow up if they go quiet.

Then I hand it all to you for review. You say yes, I hit submit.

<!-- 🖼️ IMAGE SLOT: docs/images/joblin-reading-posting.png — Joblin at his desk squinting at a pile of job postings -->
<p align="center"><img src="docs/images/joblin-reading-posting.png" alt="Joblin reading job postings at his desk" width="360"></p>

## Why a goblin on your own machine?

- **Free.** Ollama runs a language model on your laptop. No subscription, no credits, no per-application fees.
- **Private.** Your resume, your answers and your inbox stay on your computer. Nothing goes to a startup's server.
- **Yours.** Every resume, letter and email is editable before it goes anywhere. Your edits always win.
- **Bring your own brain if you want.** Prefer Claude, OpenAI or Gemini? Paste a key in Settings and I'll use that instead.

<p align="center"><img src="docs/images/joblin-robot.png" alt="Joblin dressed up as a cardboard robot" width="480"></p>

## Summon Joblin (setup)

You need [Node.js 20+](https://nodejs.org), [Ollama](https://ollama.com/download), and Google Chrome.

```bash
# 1. Give Joblin a brain (small and free, about 2 GB)
ollama pull qwen2.5:3b

# 2. Fetch the goblin
git clone https://github.com/vishinoo/joblin.git
cd joblin
npm install
npx playwright install chromium

# 3. Wake him up
npm start
```

Joblin opens in his own app window and walks you through setup: your details, your resumes, the jobs you want, connecting LinkedIn and Gmail, and how much freedom to give him.

Rather keep him in a browser tab? Run `npm run background` and visit **http://localhost:4321**.

## How Joblin works

| Mode | What happens |
|---|---|
| **Review each batch** (default) | Joblin finds jobs and prepares every application, then waits on the *Review batch* page. Approve the ones you like and he applies to just those. |
| **Autopilot** | Joblin finds, prepares and applies on a schedule without asking. For the brave. |

The browser runs invisibly in the background by default, so you can keep using your computer. Switch it to **window** in Settings → Automation to watch Joblin type.

<p align="center"><img src="docs/images/joblin-studying.png" alt="Joblin studying at his desk" width="480"></p>

### Where Joblin finds jobs

- About 75 company career boards, through their public APIs
- LinkedIn, once you connect it in Settings → Integrations

### What Joblin remembers

- **Questions:** every application question is saved with your answer and reused for similar ones.
- **Memory:** notes about you, used for future letters and emails.
- **Cover letter templates:** two editable templates (software and finance). Jobs above your fit threshold get a fully rewritten letter.

<!-- 🖼️ IMAGE SLOT: docs/images/joblin-mailbox.png — Joblin peeking into a mailbox waiting for replies -->
<p align="center"><img src="docs/images/joblin-mailbox.png" alt="Joblin checking the mailbox for replies" width="320"></p>

## Joblin's tips

<!-- 🖼️ IMAGE SLOT: docs/images/joblin-tips.png — Joblin pointing at a chalkboard like a professor -->
<img src="docs/images/joblin-tips.png" alt="Joblin giving tips" width="140" align="right">

> *"Listen to the goblin. The goblin has seen things."*

- **Feed me a good resume.** I only use bullets that are really in it, so better bullets mean better letters. Add numbers where you can.
- **Start in Review mode.** Read my first batch before trusting me with Autopilot. I'm good, but I'm still a goblin.
- **Answer my questions once, properly.** Each answer is reused forever. A sloppy answer becomes a sloppy answer fifty times.
- **Use dry runs.** `npm run dry` finds and prepares jobs without submitting anything. A good way to see what I'd do.
- **Bigger brain, better letters.** If your computer has 16 GB+ of memory, try `ollama pull qwen2.5:7b` and pick it in Settings → AI model.
- **Keep the email cap low.** The defaults (40 a day, a few minutes apart, business hours only) keep your Gmail out of trouble.
- **Edit anything.** Every letter can be edited or regenerated on the Review page before you approve it.

<p align="center"><img src="docs/images/joblin-dancing.png" alt="Joblin doing a happy dance" width="480"></p>

## Commands

```bash
npm start            # Joblin in his own app window
npm run background   # dashboard only, at http://localhost:4321
npm run run          # find and prepare a batch right now
npm run dry          # same, but never submits
npm run login        # sign into LinkedIn
```

## Where Joblin keeps his things

Everything personal stays local and is git-ignored.

| What | Where |
|---|---|
| Settings | `config.json` (created on first run from `config.example.json`, edited from the Settings page) |
| Gmail app password and API keys | `.env` (never shown in the UI) |
| Resume content | `resumes/*.json` (edit in Settings → Resumes) |
| Generated PDFs | `data/output/<job>/` |
| Database | `data/jobert.db` |

<p align="center"><img src="docs/images/joblin-vault.png" alt="Joblin guarding the vault with a tiny sword" width="480"></p>

**Gmail:** the simplest way to connect is an [App Password](https://myaccount.google.com/apppasswords) (needs 2-Step Verification). Paste it in Settings → Integrations.

## A word of goblin honesty

Joblin helps you apply. He doesn't guarantee you a job, and it's on you to read what goes out under your name. Some sites don't allow automated applications, so check the rules for the boards you use, and be kind to recruiters' inboxes.

---

<div align="center">

<img src="docs/images/joblin-rich.png" alt="Joblin after landing the job: sunglasses, cigar and a stack of gold watches" width="480">

**Like the goblin? Give him a ⭐. He keeps them in a jar.**

</div>
