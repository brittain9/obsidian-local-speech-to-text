---
name: draft-issue
description: Use when the user provides a rough braindump or dictation of something they want built/fixed and wants it turned into a GitHub issue. Phone-friendly loop — asks small clarifying questions, restates understanding, waits for explicit approval, then creates the issue via `gh` in `brittain9/obsidian-local-speech-to-text`. Handles two issue tracks - design (prose intent) and AI-task (agent-executable, labeled `ai-task`). Trigger on rough task descriptions, especially from mobile/voice input.
---

# Draft Issue

Turn a rough braindump into a GitHub issue in this repo. Optimized for the user typing or dictating from a phone.

**Repo:** `brittain9/obsidian-local-speech-to-text` (hardcoded — this skill is project-scoped).

## Two Tracks

This repo uses two distinct issue types. Choose one per issue.

- **Design issue** — product/architecture intent in prose. What + Why. An agent (or human) later decomposes it into work. No label. Examples: #4 (long-form), #37, #38 (short-form).
- **AI-task issue** — scoped, agent-executable. Behavior-level acceptance criteria plus a concrete verify step. Labeled `ai-task` so it's filterable from the main queue. May reference a parent design issue.

Never produce a hybrid. If the braindump covers both intent and execution, split it into one design issue and one or more AI-task issues.

## Flow

1. **Read the input.** Accept messy grammar, voice artifacts, incomplete thoughts. Do not ask the user to clean it up.

2. **Load context cheaply.** Before asking questions, scan `AGENTS.md`, `docs/decisions.md`, and relevant code so clarifying questions aren't things you could have discovered yourself. Skip asking about file paths, existing patterns, or architecture — find them.

3. **Pick the track.** If the braindump is clearly intent-setting ("we should rethink X") or clearly executable ("add a toggle in Y that does Z"), choose silently and tell the user which you picked. If ambiguous, ask once: "**design issue** (product/architecture intent) or **AI-task** (agent-executable)?"

4. **Ask clarifying questions in small batches.** Maximum 3 at a time. Each answerable with one short sentence. Prefer multiple-choice framing ("A, B, or neither?"). Stop once you have enough to write; do not fish for nice-to-haves.

5. **Draft the body, then restate the essence.** Send the user a 2-4 sentence summary in plain words — not the full body. Ask: "ship it, or adjust?"

6. **On adjustment**, revise and restate. Loop until approval.

7. **On explicit approval** ("ship it", "yes", "go", "create it"), run `gh issue create` and return the URL. Do NOT create before approval, even if the user sounds confident.

## Track 1: Design Issue

Match the existing voice. Read two or three recent design issues before drafting, e.g. `gh issue view 4 -R brittain9/obsidian-local-speech-to-text` (long-form) and `gh issue view 37 38 -R brittain9/obsidian-local-speech-to-text` (short-form).

**Voice patterns:**

- Design-aware prose, not agent-checklists.
- No acceptance-criteria checklists. No Verify sections. (Those are AI-task territory.)
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

### Design issue rules

- No conventional-commit prefix ("feat:", "fix:"). Imperative or descriptive titles.
- Reference `docs/decisions.md` IDs (D-NNN) rather than restating architecture.
- No motivation/stakeholder/background sections. Why already carries that.
- If the braindump hinted at scope edges, name them in prose, not a dedicated section.
- Do not apply any label (plain design issues are filtered by *absence* of `ai-task`).

## Track 2: AI-Task Issue

Use when the work is concrete enough that an agent could pick it up and finish. The body is terse and behavioral, matching `.github/ISSUE_TEMPLATE/ai-task.md`.

### Body format

```markdown
## Goal
<1-2 sentences. The outcome, not the implementation.>

## Context
- <file path / D-NNN / related PR the agent should start from>
- <relates to design issue #N — optional>

## Acceptance Criteria
- [ ] <behavior — testable, pass/fail>
- [ ] <behavior>

## Verify
<one line: exact command, specific test file, or concrete manual check>

## Non-Goals
- <explicitly out of scope>
```

### AI-task body rules

- **Goal** states outcome. Never "implement function X in file Y."
- **Acceptance Criteria** are behaviors with hard pass/fail thresholds. If a criterion could be satisfied by a stub or self-assessed as "done," rewrite it. Three criteria is usually enough; five is the upper bound.
- **Verify** must be runnable: a shell command, a specific test path, or a manual check precise enough that two people would agree whether it passed. "Tests pass" alone is too vague — name the command.
- **Context** is pointers, not prose. File paths and decision IDs beat paragraphs. This repo's AGENTS.md already holds project-level context (commands, structure, style) — don't duplicate it.
- **Non-Goals** prevent scope creep. Include at least one unless the task genuinely has no adjacent temptations.
- Omit a section only by leaving its heading out entirely — do not include empty sections.
- If the task implements part of a design issue, put `Relates to #N` in Context.

### AI-task title rules

- Imperative, under 70 chars. "Add ai-task label to draft-issue skill", "Gate initial-prompt field on selectedModelCapabilities".
- Title should be narrow enough that it's obvious when the issue is done.

## Creating the Issue

### Design issue

```bash
gh issue create -R brittain9/obsidian-local-speech-to-text \
  --title "<title>" \
  --body "$(cat <<'EOF'
<body>
EOF
)"
```

### AI-task issue

```bash
gh issue create -R brittain9/obsidian-local-speech-to-text \
  --label ai-task \
  --title "<title>" \
  --body "$(cat <<'EOF'
<body>
EOF
)"
```

Do not add other labels, assignees, or milestones unless the user asked. Return the issue URL as the final response.

## Anti-Patterns

**Both tracks:**

- Asking questions Claude could answer by reading the code.
- Creating the issue before explicit confirmation.
- "As a user, I would like…" voice.
- Restating architecture instead of citing the D-NNN.
- Silently mixing design prose and acceptance criteria in one issue.

**Design issues:**

- Acceptance-criteria checklists.
- Verify / Test plan sections.
- Expanding a 2-line braindump into long-form "just in case."

**AI-task issues:**

- Vague criteria that a stub implementation could satisfy.
- "Verify: tests pass" without naming the command or test.
- Prescribing file-level implementation in Goal ("Add foo() to bar.ts").
- Duplicating AGENTS.md content (commands, structure, style) into Context.
- Omitting Non-Goals on tasks with obvious adjacent work.
