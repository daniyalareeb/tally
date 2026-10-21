# Tally

Get hired on how you actually build. Tally keeps a tally of how you work with Claude Code, builds a skill profile verified against your GitHub commits, and lets startup founders find you. Free, by [BeRelentless](https://berelentless.dev).

## Install

In Claude Code:

```
/plugin marketplace add berelentless/tally
/plugin install tally@berelentless
/tally
```

`/tally` connects your GitHub, asks which project to count, and takes a minute. Sessions then count on their own. Run `/tally track` in each repo you want counted.

## What leaves your machine

Only for repos you track, per session:

- your own prompts, secrets removed, 400 characters max each
- numeric stats (turns, edits, test runs, retries, duration)
- commit SHAs, to check against your public GitHub history

Never your code, diffs, file contents, tool output or file paths. Run `/tally preview` to see exactly what the next upload contains. Details: https://berelentless.dev/privacy

## Commands

| Command | What it does |
|---|---|
| `/tally` | first run: setup; afterwards: your latest card |
| `/tally track` | count sessions in this repo |
| `/tally preview` | show the next upload |
| `/tally pause` | stop counting (`pause off` resumes) |

Add a `.tallyignore` file to a repo to exclude it.

## Uninstall

`/plugin uninstall tally@berelentless`, then delete `~/.tally`. Delete your account and data at https://berelentless.dev/me/settings.

Claude Code only for now. Codex support is coming.
