# Catch Vibe Code

A tool that checks whether code in a GitHub repository looks like it was written by AI or by a human. You point it at a repo, it scans the code, and gives you a score.

## What It Does

It looks at patterns in your code — things like how comments are written, how variables are named, and the overall structure — and compares them against what AI-generated code typically looks like. It then gives you a breakdown of signals so you can see what triggered the score.

Built with React, TanStack Router, Supabase, and Tailwind CSS.

## Getting Started

```bash
npm install
npm run dev
```

Run the tests with `npm test`.

## How It Works

The tool connects to GitHub, pulls down the code, runs it through a set of rules that look for AI-like patterns, and scores each file. You can compare different scans, look at the history, and tune the sensitivity of the checks.
