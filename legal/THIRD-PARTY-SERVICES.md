# Third-Party Services and Trademarks

Version 1 · Effective [EFFECTIVE DATE]

**Plenum is an independent app made by [LICENSOR NAME].** It is not affiliated with, endorsed by, sponsored by or approved by Anthropic, OpenAI, Google, Meta, xAI, DeepSeek, Mistral AI, OpenRouter, Cursor or any other company whose products it works with.

Product and company names appear in Plenum only to say which services it works with, as in "Plenum runs Claude Code". They are trademarks of their owners. Electron is a trademark of the OpenJS Foundation. Plenum does not use any of their logos. Its name and icon are its own.

## Services Plenum works with

| Service | Company | What Plenum does with it | How you connect it |
|---|---|---|---|
| Claude Code | Anthropic | Runs the official, unmodified `claude` program that you installed, and answers its permission prompts for you | Your Claude account |
| Anthropic API | Anthropic | Sends requests to Claude models when Claude Code is not installed | Your API key |
| Codex CLI | OpenAI | Runs the official `codex` program that you installed | Your ChatGPT account |
| OpenAI API | OpenAI | Sends requests to OpenAI models | Your API key |
| Gemini CLI | Google | Runs the official `gemini` program that you installed | Your Google account (see the note below) |
| Google AI (Gemini API) | Google | Sends requests to Gemini models | Your API key |
| Muse Code | Meta | Runs the official `muse` program that you installed | Your Meta account, or `META_API_KEY` |
| Grok API | xAI | Sends requests to Grok models | Your API key |
| DeepSeek API | DeepSeek | Sends requests to DeepSeek models | Your API key |
| Mistral API | Mistral AI | Sends requests to Mistral models | Your API key |
| OpenRouter | OpenRouter | Sends requests to models from many providers through OpenRouter | Your API key |
| Cursor CLI (planned) | Cursor | Will run the official program that you installed | Your Cursor account, or `CURSOR_API_KEY` |
| Grok sign-in (planned) | xAI | Will use xAI's own sign-in | Your xAI account |

## What this means for you

- **Plenum does not bundle, change or resell these services.** You install each tool from its publisher, and you sign in or add keys yourself. Plenum does not collect or store your sign-ins for these tools.
- **Their terms govern your use.** Your agreement with each provider and its usage policies apply to everything you do with that provider through Plenum. That includes any limits on using a subscription through other software and any limits on automated use. Some providers restrict this. For example, Anthropic's Claude Code documentation sets out how Claude Code may be used in third-party products and says that products should use API keys. Google's Gemini CLI terms say that reaching the services behind Gemini CLI through third-party software breaks its terms, and Google has announced that Gemini CLI sign-in for consumer plans ended in June 2026, while API-key access continues. Read the current terms before you connect a service. If a subscription plan does not allow it, use an API key where the provider offers one.
- **Services can change.** Providers can change prices, models, terms or access at any time, and Plenum may stop working with a service.
- **Prices and model details are not offers.** Prices, model names and limits shown in Plenum come from providers' pages and public listings as of the date shown, and they can be out of date. They are not offers from the providers or from us.
- **No payment, no endorsement.** Plenum receives no payment from any provider and does not endorse any of them.

## Where to read provider terms

These are the pages as published when this notice was written. Providers change them, so check the provider's own site for the current version.

- Anthropic: Consumer Terms https://www.anthropic.com/legal/consumer-terms · Commercial Terms https://www.anthropic.com/legal/commercial-terms · Usage Policy https://www.anthropic.com/legal/aup · Claude Code legal and compliance https://code.claude.com/docs/en/legal-and-compliance
- Google: Gemini CLI terms and privacy https://www.geminicli.com/docs/resources/tos-privacy · Gemini API terms https://ai.google.dev/gemini-api/terms
- Cursor: https://cursor.com/terms-of-service
- OpenRouter: https://openrouter.ai/terms
- OpenAI, Meta (Muse Code), xAI, DeepSeek and Mistral AI: see the legal pages on each provider's website.

## Open-source software

Plenum is built with open-source software, including Electron (MIT licence) and Chromium. Their licences and notices are in the app under **Legal › Open-source licences**, in the THIRD-PARTY-NOTICES.txt file installed with Plenum, and in LICENSES.chromium.html next to the app (inside the app bundle on macOS). Nothing in Plenum's License Agreement limits your rights under those licences.

## Contact

[LICENSOR NAME] · [CONTACT EMAIL]
