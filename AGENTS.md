# Codex Instructions (AGENTS.md)

## Goals
- Split multi-module/god files into small single-responsibility modules.
- Reduce duplication by extracting reusable shared modules.
- Preserve behavior and public APIs (use re-export shims when needed).

## Boundaries
- Don’t edit generated/build/vendor/deps directories.
- Avoid circular dependencies; prefer shared/core -> domain -> adapters direction.

## Quality bar
- Run lint/tests/build after each refactor batch.
- Keep files small (<=200 lines target).
- Add/extend tests when extracting shared logic.
