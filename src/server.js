import { createServer } from "node:http";
import { randomUUID } from "node:crypto";
import { mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";

import { WebSocket, WebSocketServer } from "ws";

const HOST = process.env.HOST ?? "0.0.0.0";
const PORT = Number.parseInt(process.env.PORT ?? "8080", 10);
const MODEL_PATH = path.resolve(process.cwd(), process.env.WHISPER_MODEL ?? "./models/ggml-small.bin");
const TEMP_ROOT = path.join(os.tmpdir(), "speech2text-websocket");

await mkdir(TEMP_ROOT, { recursive: true });

const httpServer = createServer((req, res) => {
  if (req.url === "/healthz") {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: true }));
    return;
  }

  res.writeHead(404, { "content-type": "application/json" });
  res.end(JSON.stringify({ error: "Not found" }));
});

const wss = new WebSocketServer({ server: httpServer });

wss.on("connection", (socket, request) => {
  console.log(`client connected from ${request.socket.remoteAddress ?? "unknown"}`);

  let activeJob = null;

  socket.on("message", async (raw, isBinary) => {
    if (isBinary) {
      sendError(socket, "Binary WebSocket frames are not supported. Send JSON text messages.");
      return;
    }

    if (activeJob) {
      sendError(socket, "A transcription job is already running for this socket.");
      return;
    }

    let message;
    try {
      message = JSON.parse(raw.toString("utf8"));
    } catch {
      sendError(socket, "Invalid JSON payload.");
      return;
    }

    if (message.type !== "transcribe") {
      sendError(socket, "Unsupported message type. Expected type='transcribe'.");
      return;
    }

    const audioBase64 = typeof message.audio === "string" ? message.audio.trim() : "";
    if (!audioBase64) {
      sendError(socket, "Missing 'audio' field containing a base64 webm/opus payload.");
      return;
    }

    const jobId = typeof message.id === "string" && message.id ? message.id : randomUUID();
    const language = typeof message.language === "string" && message.language ? message.language : "auto";

    activeJob = createJobTracker(jobId);
    sendJson(socket, {
      type: "start",
      id: jobId,
      model: MODEL_PATH,
      language,
    });

    try {
      await transcribeAudio({ socket, jobId, audioBase64, language, tracker: activeJob });
    } catch (error) {
      if (!activeJob.cancelled) {
        sendJson(socket, {
          type: "error",
          id: jobId,
          message: error instanceof Error ? error.message : String(error),
        });
      }
    } finally {
      activeJob = null;
    }
  });

  socket.on("close", () => {
    if (activeJob) {
      activeJob.cancelled = true;
      activeJob.ffmpeg?.kill("SIGTERM");
      activeJob.whisper?.kill("SIGTERM");
    }

    console.log("client disconnected");
  });
});

httpServer.listen(PORT, HOST, () => {
  console.log(`speech2text websocket backend listening on ws://${HOST}:${PORT}`);
  console.log(`using whisper model at ${MODEL_PATH}`);
});

function createJobTracker(jobId) {
  return {
    jobId,
    cancelled: false,
    ffmpeg: null,
    whisper: null,
    transcript: "",
    tail: "",
    emittedLength: 0,
  };
}

async function transcribeAudio({ socket, jobId, audioBase64, language, tracker }) {
  const jobDir = path.join(TEMP_ROOT, jobId);
  const inputPath = path.join(jobDir, "input.webm");
  const wavPath = path.join(jobDir, "input.wav");

  await mkdir(jobDir, { recursive: true });

  try {
    const audioBuffer = decodeBase64Audio(audioBase64);
    await writeFile(inputPath, audioBuffer);

    await convertWebmToWav({ inputPath, wavPath, tracker });
    if (tracker.cancelled) {
      return;
    }

    await runWhisper({ socket, jobId, wavPath, language, tracker });

    if (!tracker.cancelled) {
      sendJson(socket, {
        type: "done",
        id: jobId,
        text: tracker.transcript.trim(),
      });
    }
  } finally {
    await rm(jobDir, { recursive: true, force: true });
  }
}

function decodeBase64Audio(audioBase64) {
  const normalized = audioBase64.includes(",")
    ? audioBase64.slice(audioBase64.indexOf(",") + 1)
    : audioBase64;

  try {
    return Buffer.from(normalized, "base64");
  } catch {
    throw new Error("Audio payload is not valid base64.");
  }
}

function convertWebmToWav({ inputPath, wavPath, tracker }) {
  return new Promise((resolve, reject) => {
    const ffmpeg = spawn("ffmpeg", [
      "-y",
      "-i",
      inputPath,
      "-ar",
      "16000",
      "-ac",
      "1",
      "-c:a",
      "pcm_s16le",
      wavPath,
    ]);

    tracker.ffmpeg = ffmpeg;

    let stderr = "";
    ffmpeg.stderr.on("data", (chunk) => {
      stderr += chunk.toString("utf8");
    });

    ffmpeg.on("error", (error) => {
      reject(new Error(`Failed to start ffmpeg: ${error.message}`));
    });

    ffmpeg.on("close", (code) => {
      tracker.ffmpeg = null;

      if (tracker.cancelled) {
        resolve();
        return;
      }

      if (code === 0) {
        resolve();
        return;
      }

      reject(new Error(`ffmpeg exited with code ${code}: ${stderr.trim()}`));
    });
  });
}

function runWhisper({ socket, jobId, wavPath, language, tracker }) {
  return new Promise((resolve, reject) => {
    const whisper = spawn("whisper-cli", [
      "-m",
      MODEL_PATH,
      "-f",
      wavPath,
      "-l",
      language,
      "-nt",
      "-np",
    ]);

    tracker.whisper = whisper;

    let stderr = "";

    whisper.stdout.on("data", (chunk) => {
      const text = chunk.toString("utf8");
      tracker.tail += text;
      flushTranscript(socket, jobId, tracker, false);
    });

    whisper.stderr.on("data", (chunk) => {
      stderr += chunk.toString("utf8");
    });

    whisper.on("error", (error) => {
      reject(new Error(`Failed to start whisper-cli: ${error.message}`));
    });

    whisper.on("close", (code) => {
      tracker.whisper = null;
      flushTranscript(socket, jobId, tracker, true);

      if (tracker.cancelled) {
        resolve();
        return;
      }

      if (code === 0) {
        resolve();
        return;
      }

      reject(new Error(`whisper-cli exited with code ${code}: ${stderr.trim()}`));
    });
  });
}

function flushTranscript(socket, jobId, tracker, isFinalFlush) {
  const parsed = parseTranscript(tracker.tail, isFinalFlush);
  tracker.tail = parsed.remainder;

  if (!parsed.text) {
    return;
  }

  const separator =
    tracker.transcript && !tracker.transcript.endsWith(" ") && !parsed.text.startsWith("'")
      ? " "
      : "";
  const nextTranscript = `${tracker.transcript}${separator}${parsed.text}`;
  const delta = nextTranscript.slice(tracker.emittedLength);
  tracker.transcript = nextTranscript;
  tracker.emittedLength = nextTranscript.length;

  if (!delta) {
    return;
  }

  sendJson(socket, {
    type: "delta",
    id: jobId,
    text: delta,
    fullText: tracker.transcript.trimStart(),
  });
}

function parseTranscript(buffer, isFinalFlush) {
  const lines = buffer.split(/\r?\n/);
  const remainder = isFinalFlush ? "" : lines.pop() ?? "";

  const parts = [];
  for (const line of lines) {
    const cleaned = line
      .replace(/\[[^\]]+\]/g, " ")
      .replace(/\s+/g, " ")
      .trim();

    if (!cleaned) {
      continue;
    }

    parts.push(cleaned);
  }

  if (isFinalFlush) {
    const cleanedRemainder = remainder
      .replace(/\[[^\]]+\]/g, " ")
      .replace(/\s+/g, " ")
      .trim();

    if (cleanedRemainder) {
      parts.push(cleanedRemainder);
    }
  }

  return { text: parts.join(" "), remainder };
}

function sendError(socket, message) {
  sendJson(socket, { type: "error", message });
}

function sendJson(socket, payload) {
  if (socket.readyState === WebSocket.OPEN) {
    socket.send(JSON.stringify(payload));
  }
}
