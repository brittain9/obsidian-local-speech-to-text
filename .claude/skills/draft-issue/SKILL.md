---
name: draft-issue
description: Use when the user provides a rough braindump or dictation of something they want built/fixed and wants it turned into a GitHub issue. Phone-friendly loop — asks small clarifying questions, restates understanding, waits for explicit approval, then creates the issue via `gh` in `brittain9/obsidian-local-speech-to-text`. Handles two issue tracks - discussion (prose intent, labeled `discussion`) and agent task (agent-executable, labeled `agent`). Trigger on rough task descriptions, especially from mobile/voice input.
---

# Draft Issue

Turn a rough braindump into a GitHub issue in this repo. Optimized for the user typing or dictating from a phone.

**Repo:** `brittain9/obsidian-local-speech-to-text` (hardcoded — this skill is project-scoped).

## Two Tracks

This repo uses two distinct issue types. Choose one per issue.

- **Discussion** — research, design, or architecture intent in prose. What + Why. Something to talk about; an agent (or human) later decomposes it into work. Labeled `discussion`. Examples: #4 (long-form), #37, #38 (short-form).
- **Agent task** — scoped, agent-executable. Behavior-level acceptance criteria plus a concrete verify step. Labeled `agent` so it's filterable from the main queue. May reference a parent discussion.

Never produce a hybrid. If the braindump covers both intent and execution, split it into one discussion and one or more agent tasks.

## Flow

1. **Read the input.** Accept messy grammar, voice artifacts, incomplete thoughts. Do not ask the user to clean it up.

2. **Load context cheaply.** Before asking questions, scan `AGENTS.md`, `docs/decisions.md`, and relevant code so clarifying questions aren't things you could have discovered yourself. Skip asking about file paths, existing patterns, or architecture — find them.

3. **Pick the track.** If the braindump is clearly intent-setting ("we should rethink X") or clearly executable ("add a toggle in Y that does Z"), choose silently and tell the user which you picked and why in one phrase. If ambiguous, ask once: "**discussion** (research/design/architecture) or **agent task** (agent-executable)?"

4. **Ask clarifying questions in small batches.** Maximum 3 at a time. Each answerable with one short sentence. Prefer multiple-choice framing ("A, B, or neither?"). Stop once you have enough to write; do not fish for nice-to-haves.

5. **Draft the body, then restate the essence.** Send the user a 2-4 sentence summary in plain words — not the full body. Ask: "ship it, or adjust?"

6. **On adjustment**, revise and restate. Loop until approval.

7. **On explicit approval** ("ship it", "yes", "go", "create it"), run `gh issue create` and return the URL. Do NOT create before approval, even if the user sounds confident.

## Track 1: Discussion

Match the existing voice. Read `gh issue view 4 37 38 -R brittain9/obsidian-local-speech-to-text` to ground in the actual short- and long-form patterns before drafting.

**Voice patterns:**

- Design-aware prose, not agent-checklists.
- No acceptance-criteria checklists. No Verify sections. (Those are agent-task territory.)
- Rationale is load-bearing. "Why" constrains the solution space.
- Direct voice, no corporate template ("As a user, I would like…").

**Scope decision — short vs long form:** Default to short. Escalate to long only when the work involves architectural change, multiple interacting surfaces, or a design tradeoff worth documenting.

### Short form — default

```markdown
## What
<1-3 sentences. Describe the change as a product fact, not an implementation plan.>

## Why
<1-3 sentences. The design rationale — what this unlocks, what it fixes, what existing rhythm it matches. Reference decisions (D-NNN) when relevant.>
```

### Long form — architectural or multi-surface work

```markdown
### What and why?

<Prose. Open with the problem or change in plain terms. Then lay out changes — numbered if distinct — with rationale woven in. Each change should be understandable on its own.>

### Current workaround

<Optional. Only if users have a usable-but-flawed path today.>

### Design considerations

- **<Consideration>**: <explanation>
- **<Consideration>**: <explanation>
```

### Discussion rules

- No conventional-commit prefix ("feat:", "fix:"). Imperative or descriptive titles.
- Reference `docs/decisions.md` IDs (D-NNN) rather than restating architecture.
- No motivation/stakeholder/background sections. Why already carries that.
- If the braindump hinted at scope edges, name them in prose, not a dedicated section.
- Apply the `discussion` label.

## Track 2: Agent Task

Use when the work is concrete enough that an agent could pick it up and finish. Match `.github/ISSUE_TEMPLATE/agent-task.md` — Goal, Context, Acceptance Criteria, Verify, optional Notes, optional Non-Goals.

### Agent task body rules

- **Goal** states outcome. Never "implement function X in file Y."
- **Acceptance Criteria** are behaviors with hard pass/fail thresholds. If a criterion could be satisfied by a stub or self-assessed as "done," rewrite it. Prefer ≤6 criteria; if a task needs more, it probably wants splitting — but don't fracture genuinely atomic multi-surface work (e.g. CI + script + docs for one platform).
- **Verify** must be runnable: a shell command, a specific test path, or a manual check precise enough that two people would agree whether it passed. "Tests pass" alone is too vague — name the command.
- **Context** is pointers — file paths, decision IDs, related PRs — with brief rationale where it carries weight. This repo's AGENTS.md already holds project-level context (commands, structure, style) — don't duplicate it.
- **Notes** is for non-binding hints. Keep implementation prescriptions out of AC; if a hint matters, put it here, not as a checkbox.
- **Non-Goals** are optional. Include when adjacent scope creep is a plausible temptation. Do not invent fences for narrow tasks.
- If the task implements part of a discussion, put `Relates to #N` in Context.

### Agent task title rules

- Imperative, under 70 chars. "Add agent label to draft-issue skill", "Gate initial-prompt field on selectedModelCapabilities".
- Title should be narrow enough that it's obvious when the issue is done.

## Creating the Issue

### Discussion

```bash
gh issue create -R brittain9/obsidian-local-speech-to-text \
  --label discussion \
  --title "<title>" \
  --body "$(cat <<'EOF'
<body>
EOF
)"
```

### Agent task issue

```bash
gh issue create -R brittain9/obsidian-local-speech-to-text \
  --label agent \
  --title "<title>" \
  --body "$(cat <<'EOF'
<body>
EOF
)"
```

Do not add other labels, assignees, or milestones unless the user asked. Return the issue URL as the final response.
