# Subagent model and review policy

Read this before spawning or steering a `rex-subagent`. Explicit user instructions for a model or thinking level override this policy.

## Selection rules

- Select models from Pi's current scoped-models (`enabledModels`). If a listed route is absent or unavailable, use another primary in the same row before trying its backups.
- Pass `--model` and `--thinking` explicitly. Thinking support is model-specific; do not assume that every model supports `medium`.
- Keep every DeepAI model in a backup role. Primary rotations contain only non-DeepAI models.
- Reserve `max` and `xhigh` for exceptionally difficult or high-risk work. In the table, `high → max` means start at `high` and escalate only when warranted.
- Keep the same model for follow-up turns sent to an existing run.

## Task pools

| Task | Primary pool | Backups |
| --- | --- | --- |
| File location, log summarization, mechanical extraction | `magpie/workbuddy/deepseek-v4.1-flash` + `off` for pure extraction or `low` for light synthesis | `magpie/amd-radeon-cloud/DeepSeek-V4.1-Flash` + `low`; `magpie/deepai/deepseek-v4.1-flash` + `minimal/low` |
| Read-only code exploration, routine research | `magpie/workbuddy/hy4flash-free` + `high` | `magpie/stepfun-cn/step-5-preview` + `medium`; `magpie/zcode/GLM-5.3-Flash` + `high`; `magpie/deepai/glm-5.3-flash` + `medium` |
| Routine implementation, localized fixes, test runs | `magpie/devin/swe-2-flash` + `high`; `magpie/workbuddy/hy4flash-free` + `high`; `magpie/mistral/deepseek-v4-1-flash-1017` + `high` | `magpie/kimi-code-cn/k3.1-pro` + `high`; `magpie/deepai/deepseek-v4.1-flash` + `high` |
| Cross-module implementation, difficult debugging, architecture analysis | `magpie/kimi-code-cn/k3.1-pro` + `high → max` | `magpie/zcode/GLM-5.3` + `high → max` |
| Independent code review, second opinion | `magpie/grok/grok-4.7-build-fast@500k` + `high`; `magpie/zcode/GLM-5.3` + `high` | `magpie/stepfun-cn/step-5-preview` + `high`; `magpie/deepai/muse-ember` + `medium` |
| Security review, data-loss risk, final high-risk review | `magpie/grok/grok-4.7@500k` + `xhigh` | A different model family from the implementer: `magpie/zcode/GLM-5.3` + `max` or `magpie/kimi-code-cn/k3.1-pro` + `max` |

## Load balancing

For each new routine implementation task, advance through this cycle within the current parent session:

```text
magpie/devin/swe-2-flash:high
→ magpie/workbuddy/hy4flash-free:high
→ magpie/mistral/deepseek-v4-1-flash-1017:high
```

For each new independent-review task, alternate between:

```text
magpie/grok/grok-4.7-build-fast@500k:high
↔ magpie/zcode/GLM-5.3:high
```

Assign parallel independent tasks to different primary models when practical. When multiple reviewers inspect the same change, use both reviewer primaries. Prefer a reviewer from a different model family than the implementer.

## Mandatory Reviewer workflow

A subagent assigned any review of workspace changes, a PR, a commit, or a branch comparison is a **Reviewer**. Every Reviewer must load and follow the `open-code-review-delegate` skill for all of that review work.

- Use the skill's complete delegation flow: `ocr delegate preview`, `ocr delegate rule`, mode-appropriate diffs, per-file review, and the required output format. Pass the requested scope and matching refs to both OCR subcommands.
- Account for every `reviewable_files` entry as `reviewed` or `skipped` with a concrete reason. Report `total_files`, `reviewed_files`, `skipped_files`, and `coverage_rate`.
- Keep skills enabled and give the Reviewer at least `read,bash,grep,find`. Bash is required for OCR and Git; do not spawn a Reviewer with a tool set that omits Bash or with `--no-skills`.
- Use delegation mode only. If the OCR CLI is unavailable or the workflow is blocked, follow the skill's troubleshooting instructions and report the blocker; do not substitute native `open-code-review` or an ad hoc diff review.
