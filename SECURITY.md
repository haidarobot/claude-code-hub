# Security

Claude Code Hub gives a browser the power to run Claude Code — and therefore commands — on your machine. Please take security reports seriously, and so will we.

## Reporting a vulnerability

Please **do not open a public issue** for security problems. Use GitHub's private reporting instead: **Security → Report a vulnerability** on this repository. Include steps to reproduce and the version or commit you tested.

You should get an answer within a few days.

## Hardening checklist

- Keep `HOST=127.0.0.1` and reach the hub through Tailscale, a VPN, or an HTTPS reverse proxy.
- If the hub is reachable from a network, set a long random `AUTH_PASSWORD` (or use `AUTH_MODE=proxy` behind real authentication).
- Run the service as an unprivileged user. Avoid giving that user passwordless `sudo`.
- Prefer the **Ask first** or **Auto** permission modes. Use **Bypass** only in a disposable sandbox.
- Keep Node.js, Claude Code and this project up to date (`git pull && npm install`).
