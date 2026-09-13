## Summary

Brief description of what this pull request changes and why.

> [!NOTE]
> **Commit message convention**:
> All commits must follow the `type: contents` format (lowercase type, colon, space, non-empty English imperative summary). Examples: `feat: add catalog search shortcut`, `fix: handle midnight streak transition`. Valid types: `feat`, `fix`, `chore`, `test`, `refactor`, `style`, `docs`, `build`, `ci`, `perf`, `revert`.

## Validation performed

- [ ] `npm run check` (TypeScript static analysis) passes with zero errors
- [ ] `npm test` (Automated test suite) passes completely
- [ ] `npm run build` (Vite frontend production build) succeeds
- [ ] `npm run docs:check` (Documentation link checker) validates all markdown links
- [ ] `git diff --check` passes with zero whitespace errors

## Scope and boundary checklist

- [ ] Adheres to Desktop-Only UI scope (no phone-specific layouts or mobile touch code)
- [ ] Strictly Bring-Your-Own-Data compliant (zero crawled problem content or copyrighted datasets added)
- [ ] Zero sensitive credentials, private tokens, or personal database files included
- [ ] Documentation updated in `docs/` or root Markdown files where appropriate (in English)
