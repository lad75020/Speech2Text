# Speech2Text WebSocket Backend

Minimal Node.js transcription service that exposes:

- a WebSocket API for streaming transcript updates
- a stateless HTTP MCP endpoint for agent tool calls returning only the final transcript

Both transports accept `webm/opus` audio as base64, convert it to mono 16 kHz WAV with `ffmpeg`, and run `whisper-cli`.

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

Host and port can come from `.env` or from environment variables. Environment variables win if both are set.

- `LDU_WHISPER_HOST` default: `0.0.0.0`
- `LDU_WHISPER_PORT` default: `8080`
- `WHISPER_MODEL` default: `./models/ggml-small.bin`

Example `.env`:

```bash
LDU_WHISPER_HOST=0.0.0.0
LDU_WHISPER_PORT=8080
```

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

## Browser Test Page

A standalone WebSocket test client is available at `test/websocket-test.html`.

- Default backend URL: `wss://whisper.dubertrand.fr`
- Open it from a secure origin such as `https://...` or `http://localhost/...` so the browser allows microphone access.

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

## MCP protocol

Connect MCP clients to `http://<server>:8080/mcp` using Streamable HTTP.

The server exposes one MCP tool:

- `transcribe`

Tool input schema:

```json
{
  "type": "transcribe",
  "id": "optional-request-id",
  "language": "auto",
  "audio": "BASE64_WEBM_OPUS"
}
```

The `audio` field may also be a data URL such as `data:audio/webm;base64,...`.

Tool result:

- a single text response containing the final transcript only

This MCP endpoint is stateless and shares the same single global transcription queue as the WebSocket API.

## Notes

- No authentication or TLS is included.
- This is intended for trusted local-network callers.
- Whisper output is streamed as it is printed by `whisper-cli`, so chunk boundaries depend on Whisper segmentation.
