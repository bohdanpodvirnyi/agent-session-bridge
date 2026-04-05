# Release Checklist

- Run `pnpm release:check`
- Run `pnpm build`
- Confirm sanitized fixtures still parse with `pnpm fixture:validate`
- Review `docs/HOOKS.md` and `docs/TROUBLESHOOTING.md`
- Verify release notes reflect the latest live validation status
