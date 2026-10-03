# Security

## Threat model

Sotto is a single-user app that runs on your own Mac. It has no accounts and no login: anything that can reach its API can read and change your library. So it's designed to be reachable only from your Mac and only by its own pages.

- **Loopback only.** The web server, the speech engine and the optional Caddy proxy listen on `127.0.0.1` / `::1`. Nothing is reachable from your network.
- **Host check.** The API answers only requests addressed to `localhost`, `127.0.0.1`, `[::1]` or your configured `SOTTO_HOST`; anything else gets `421`. This stops DNS-rebinding attacks, where a website re-points its own name at `127.0.0.1`.
- **Origin check.** Requests that change data, and the dictation WebSocket, are refused (`403`) if they come from another site (`Origin` or `Sec-Fetch-Site`). Websites you visit can't upload, delete or record into your library.
- **Optional HTTPS proxy.** Caddy runs as root only because macOS requires root to bind port 443 on a specific address. Its admin API is off, and it reads a root-owned copy of its config, so no program running as you can reconfigure it. Its certificate authority is created on your Mac, trusted only there, and removed exactly by `scripts/uninstall.sh`.
- **Secrets.** A clean-up API key is stored in `config.env` with permissions `600` and is never sent to the browser.
- **Clean-up providers** receive transcript text (never audio). Hosted providers are opt-in. Both CLI providers run from an empty directory and save no session: Claude with its tools and MCP servers off, Codex in a read-only sandbox without your Codex configuration.

## Reporting a vulnerability

Please don't open a public issue. Use GitHub's [private vulnerability reporting](https://github.com/siddharthborderwala/sotto/security/advisories/new) instead, with steps to reproduce. You'll get a reply within a few days.
