# Skills

## `typesafe-ai` (Jev / TypeSafe System One)

Vendored from [typesafe-ai/skills](https://github.com/typesafe-ai/skills) so agents working in this repo know how to use **Jev**.

- Read [`typesafe-ai/SKILL.md`](./typesafe-ai/SKILL.md) before changing Jev prompts, question shapes, or Gateway wiring.
- Live docs remain the source of truth: https://docs.typesafe.ai/llms.txt
- **This project calls Jev only through Vercel AI Gateway** as `typesafe-ai/jev` (see `ARCHITECTURE.md`). Never call the TypeSafe API directly from Jevis.

Optional install into Claude Code / Codex plugin hosts:

```bash
claude plugin marketplace add typesafe-ai/skills
claude plugin install typesafe@typesafe-ai
```

Upstream snapshots of plugin manifests are under `.claude-plugin/typesafe-upstream-*.json`.
