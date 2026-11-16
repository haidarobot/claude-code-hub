# Contributing

Thanks for wanting to help! Bug reports, ideas, translations and pull requests are all welcome.

## Development

```bash
git clone https://github.com/haidarobot/claude-code-hub.git
cd claude-code-hub
npm install
npm start          # http://127.0.0.1:3010
```

There is no build step. Edit a file in `public/` and reload the browser; restart `npm start` after changing `src/`.

| Path | What lives there |
|---|---|
| `src/server.js` | HTTP API, WebSocket, routing |
| `src/live.js` | One running Claude Code session (Agent SDK), permissions, streaming |
| `src/files.js` | Folder listing, file preview, file search, git |
| `src/auth.js` | Built‑in password login |
| `src/config.js` | Environment variables |
| `src/notify.js` | Telegram / ntfy / command notifications |
| `public/app.js` | The whole frontend |
| `public/i18n.js` | Translations (UI source text is Indonesian, mapped to English) |
| `public/style.css` | macOS look, light & dark, phone layout |

## Guidelines

- Keep it dependency‑light and build‑free.
- Match the macOS look: system font, hairline borders, segmented controls, no heavy shadows.
- Test on a phone‑sized window as well as desktop, in light and dark mode.
- New UI text: add the English translation to `public/i18n.js`.
- One topic per pull request, with a short description and a screenshot for UI changes.

## Adding a language

1. In `public/i18n.js`, add a dictionary for your language next to `EN` and pick it in `tr()`.
2. Add it to the language menu in `public/app.js` (search for `setLang`).
3. Open a pull request — thank you!
