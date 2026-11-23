# Security

## Never commit credentials

This project reads the iWencai credential from `IWENCAI_API_KEY` or accepts it in the local **数据设置** dialog for the current server process. A real key must never be placed in source files, screenshots, issue bodies, test fixtures, `.env` files, or Git history.

The repository ignores local data, imported spreadsheets, screenshots, `.env` files, and common secret files. This is a safety net, not a substitute for reviewing every commit.

If a key is exposed, revoke or rotate it in iWencai SkillHub immediately and remove it from Git history before publishing.

## Report a vulnerability

Please avoid posting credentials or sensitive market-review data in a public issue. Describe the security impact without including secrets or private datasets.

