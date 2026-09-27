# P5 permission audit

> Historical audit from 2026-05-12. Permission justifications below describe an earlier multi-provider product and are not current Web Store submission evidence. Re-audit `manifest.json` before any store submission.

Status: ready for reviewer copy, manual Web Store review still required.
Date: 2026-05-12

## Manifest permissions

| Permission | Status | Justification |
|---|---|---|
| `activeTab` | Keep | User starts 译幕 from the toolbar on the active YouTube tab. |
| `scripting` | Keep | Background injects content scripts into already open YouTube tabs after user action. |
| `storage` | Keep | Saves tier, language, voice, volume, style settings, optional API keys, and caption cache locally. |

## Host permissions

| Origin | Status | Code refs | Store note |
|---|---|---|---|
| `https://*.youtube.com/*`, `https://youtube.com/*` | Keep | `manifest.json`, `services/captions.js`, content scripts | Reads YouTube captions, captures active video audio when user starts dub, renders overlay on YouTube. |
| `https://api.kymaapi.com/*` | Keep | `services/kyma-client.js`, `pipelines/standard.js` | Optional legacy standard dubbing calls Kyma with the user's Kyma key. No 译幕 server. |
| `https://api.minimax.cn/*` | Keep | `services/minimax.js`, `services/translate.js`, `pipelines/standard.js` | Default domestic ASR, model translation, and TTS call MiniMax with the user's own key. |
| `https://api.openai.com/*` | Keep | `services/tts-openai.js`, `services/translate.js` | OpenAI TTS or OpenAI translation when selected by user. |
| `https://generativelanguage.googleapis.com/*` | Keep | `services/translate.js` | Gemini translation when selected by user with their key. |
| `https://openrouter.ai/*` | Keep | `services/translate.js` | OpenRouter translation when selected by user with their key. |
| `https://api.groq.com/*` | Keep | `services/stt-groq.js`, `services/translate.js` | Groq STT or translation when selected by user with their key. |
| `https://api-inference.huggingface.co/*`, `https://huggingface.co/*` | Review before submit | `services/providers.js` lists Hugging Face provider metadata. No active fetch call found in current JS audit. | Keep only if Hugging Face provider is enabled before submission. Otherwise remove to reduce review risk. |
| `https://translate.googleapis.com/*` | Keep | `services/translate.js` | Default free caption translation endpoint. |
| `https://translation.googleapis.com/*` | Keep | `services/translate.js` | Google Cloud Translation when selected by user with their key. |
| `https://texttospeech.googleapis.com/*` | Keep | `services/tts-browser.js` | Google Cloud Text to Speech when selected by user with their key. |
| `https://stt-rt.soniox.com/*` | Keep | `services/stt-soniox.js` | Soniox caption fallback STT when selected by user with their key. |
| `https://libretranslate.com/*` | Keep | `services/translate.js`, `services/providers.js` | Managed LibreTranslate endpoint when selected. |
| `http://localhost/*`, `http://127.0.0.1/*` | Keep if self hosted LibreTranslate is a listed feature | `services/providers.js` default placeholder | Local self hosted LibreTranslate. If local provider support is removed from listing, remove these origins too. |

## Findings

1. No broad `<all_urls>` permission found.
2. YouTube content script matches are limited to YouTube origins.
3. Hugging Face origins appear reserved but no active fetch call was found. Decide before submission.
4. Localhost permissions are justified only by self hosted LibreTranslate.

## Reviewer notes source

`store-assets/web-store-metadata.md` contains permission justifications for Web Store form copy.
