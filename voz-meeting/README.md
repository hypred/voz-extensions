# voz-meeting

A [Voz](https://github.com/Joelheile/voz) extension that records meetings. Press the hotkey to start, press it again to stop. Voz transcribes your microphone and everything your Mac plays, such as Zoom, Meet or Teams, on your Mac and copies the transcript to the clipboard.

When a supported call app uses both your microphone and audio output continuously for 20 seconds, Voz asks whether to record. One click on **Record** starts it, and the hotkey stops it. Voz dictation, microphone-only voice notes and audio playing in another app do not qualify.

Automatic suggestions cover native Zoom, Teams, Webex, Slack, FaceTime, Discord, Signal, WhatsApp, Telegram, GoTo and RingCentral when macOS can attribute both audio directions to them.

Messaging apps such as WhatsApp, Telegram, Signal, Slack and Discord also need an enabled call control, so voice notes and playback alone do not qualify.

Browser calls are included by default. They require a known meeting site's HTTPS page with both an enabled microphone control and a leave/end-call control in that same web area. Supported sites include Google Meet, Teams, Zoom, Webex, Jitsi Meet, Whereby, Slack, Discord, GoTo and RingCentral. Private meeting hosts can be added in settings. Safari, Chrome, Edge, Firefox, Brave, Arc, Vivaldi, Opera, Chromium, Orion, Zen and other browsers and their release channels are listed in `detection-config.json`. Call-control labels currently cover English and German. All apps can still be recorded with the hotkey.

Each browser meeting page gets a temporary opaque identity. Switching meetings invalidates old dialog answers; returning to a declined tab does not repeat the prompt while the browser keeps its microphone open. After you click **Record**, the helper must freshly confirm the same meeting before recording starts. Missing, stale or inconclusive evidence prevents an automatic start.

While a meeting records, the Voz menu bar icon shows a red dot and the Voz panel shows the time and a Stop button. Finished transcripts also appear in the Voz history, where you can search and copy them.

Each meeting is saved as `YYYY-MM-DD-HHMM.md` and `.m4a` in `~/Documents/Voz Meetings`. Words from your Voz dictionary are boosted.

## Install

```
voz install voz-meeting
```

Needs Apple Silicon and the macOS version Voz requires. macOS asks Voz for system audio access on the first recording.

## Settings

Change them on the Extensions page in Voz.

- **Hotkey**: default `ctrl+opt+m`. A single key without modifiers works too, such as `end`
- **Folder**: where transcripts and recordings go
- **Copy transcript to clipboard**: on by default
- **Suggest recording meetings**: on by default. Requires 20 seconds of microphone and output use by the same supported app. Asks once, and only rearms after at least 10 seconds without that app's microphone use. Hidden call controls do not rearm the prompt
- **Include browser calls**: on by default. Requires attributable microphone and output use plus enabled microphone and leave/end-call controls on the same recognized HTTPS meeting page. Turning this off also stops browser UI inspection
- **Additional meeting sites**: comma-separated hostnames, such as `meet.example.org`, for self-hosted or private meeting services. These pages still require the same call controls; adding a hostname alone never triggers a hint

## Notes

- Without headphones your speakers reach the microphone, so other people can appear twice in the transcript
- The transcript has no speaker labels
- Call detection reads local audio-process metadata and accessible call-button labels. The browser helper also reads the page address locally to identify navigation. Only the hostname, control-presence flags and an opaque keyed token leave the helper; full addresses, room IDs, page text, text-field values and window titles are neither emitted nor logged. The token key is random per helper run and is never saved. Detection records no audio and sends nothing to external services
- Call-control checks require Accessibility access for the helper under Voz. No permission dialog is opened by detection. Without access or identifiable call controls, automatic suggestions for browsers and messaging apps stay silent
- Muted calls, minimized windows, background tabs and apps with unidentifiable audio helpers may not trigger a suggestion. A visible call page and unrelated audio in another tab can still qualify; macOS cannot link audio to a particular tab. Native-app audio device previews can also qualify if they use both directions

## Development

Run `bun test` for detection tests. On an Apple Silicon Mac, run `bun run check:native`: it rebuilds the helper with the Command Line Tools, verifies version 2 snapshots and timestamp freshness, requests a fresh scan and checks clean shutdown when stdin closes. It records no audio. Packaging also rebuilds `meeting-rec` through `prepack`, so a published package cannot silently include an old helper. An older helper disables automatic suggestions rather than falling back to the global microphone heuristic; manual recording still works.

Before publishing, verify on macOS: a long Voz dictation causes no prompt; a native Zoom or Teams call prompts once after 20 seconds; declining or briefly muting does not repeat it; ending the call closes a pending prompt; another call can prompt after the grace period. In Safari, Chromium and Firefox, test Meet, Teams, Zoom, Webex, Jitsi, Whereby and Slack in English and German; verify no prompt during browser dictation with unrelated playback or on pre-join screens. Check behavior without Accessibility access, after disabling browser hints, with a minimized window and after leaving a call while playback continues. Check that changing meeting tabs after clicking Record cannot start the new meeting, returning to a declined tab stays quiet, and a private host only works after configuration. The Linux tests exercise synthetic process/page snapshots and dialog lifecycle; they cannot verify real client accessibility trees, stable window identities or native compilation. The native smoke check does not replace those real-call checks.

The app and browser catalogue is shared by TypeScript and the native helper. Browser IDs come from [Apple's browser metadata](https://github.com/apple/password-manager-resources/blob/main/quirks/web-browser-extension-distribution-information.json); native client IDs were checked against upstream or public deployment manifests, including [Signal](https://github.com/signalapp/Signal-Desktop/blob/main/package.json) and [RingCentral](https://github.com/ugurkocde/IntuneBrew/blob/main/Apps/ringcentral.json). Add exact identifiers to `detection-config.json`; do not match arbitrary bundle-ID prefixes.
