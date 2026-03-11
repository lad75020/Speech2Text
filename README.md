# Speech2Text WebSocket Backend

Minimal Node.js WebSocket server that accepts `webm/opus` audio as base64, converts it to mono 16 kHz WAV with `ffmpeg`, runs `whisper-cli`, and streams transcript text back over the same socket.

## Requirements

- `node >= 20`
- `ffmpeg` in `PATH`
- `whisper-cli` in `PATH`
- Whisper model at `./models/ggml-small.bin`

## Install

```bash
npm install
```

## Run

```bash
npm start
```

Optional environment variables:

- `HOST` default: `0.0.0.0`
- `PORT` default: `8080`
- `WHISPER_MODEL` default: `./models/ggml-small.bin`

## launchd

User-scoped LaunchAgent for `laurent`:

- Source plist: `launchd/com.laurent.speech2text.websocket.plist`
- Installed plist: `/Users/laurent/Library/LaunchAgents/com.laurent.speech2text.websocket.plist`
- Install and start now: `./launchd/install-launchagent.sh`

Useful commands:

```bash
launchctl print gui/$(id -u laurent)/com.laurent.speech2text.websocket
launchctl kickstart -k gui/$(id -u laurent)/com.laurent.speech2text.websocket
tail -f /Users/laurent/Library/Logs/Speech2Text/launchd.stdout.log
tail -f /Users/laurent/Library/Logs/Speech2Text/launchd.stderr.log
```

## WebSocket protocol

Connect to `ws://<server>:8080`.

Send JSON:

```json
{
  "type": "transcribe",
  "id": "optional-request-id",
  "language": "auto",
  "audio": "BASE64_WEBM_OPUS"
}
```

The `audio` field may also be a data URL such as `data:audio/webm;base64,...`.

Server responses:

- `{"type":"queued","id":"...","position":1}`
- `{"type":"start","id":"...","model":"...","language":"auto"}`
- `{"type":"delta","id":"...","text":"new fragment","fullText":"full transcript so far"}`
- `{"type":"done","id":"...","text":"final transcript"}`
- `{"type":"error","id":"...","message":"..."}`

Transcription jobs are processed through a single global queue, one at a time.

## Notes

- No authentication or TLS is included.
- This is intended for trusted local-network callers.
- Whisper output is streamed as it is printed by `whisper-cli`, so chunk boundaries depend on Whisper segmentation.
