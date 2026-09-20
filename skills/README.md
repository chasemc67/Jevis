# Vendored skills

Agents must read [`typesafe-ai/SKILL.md`](typesafe-ai/SKILL.md) before changing the Jev integration, including prompts, question shapes, or Gateway wiring. The skill is vendored from [typesafe-ai/skills](https://github.com/typesafe-ai/skills), with its [MIT license](typesafe-ai/LICENSE) preserved.

Live documentation at [docs.typesafe.ai](https://docs.typesafe.ai) remains the source of truth; use the [documentation index](https://docs.typesafe.ai/llms.txt) to find current guidance.

**Jevis uses Vercel AI Gateway model `typesafe-ai/jev`. Never call the TypeSafe API directly from this project.** See [ARCHITECTURE.md](../ARCHITECTURE.md) for the integration boundary.
