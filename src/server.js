import { createServer } from "node:http";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { WebSocket, WebSocketServer } from "ws";
import * as z from "zod/v4";

const PROJECT_ROOT = process.cwd();
const dotEnv = await loadDotEnvFile(path.join(PROJECT_ROOT, ".env"));
const HOST = process.env.LDU_WHISPER_HOST ?? dotEnv.LDU_WHISPER_HOST ?? "0.0.0.0";
const PORT = parsePort(process.env.LDU_WHISPER_PORT ?? dotEnv.LDU_WHISPER_PORT ?? "8080");
const MODEL_PATH = path.resolve(process.cwd(), process.env.WHISPER_MODEL ?? "./models/ggml-small.bin");
const TEMP_ROOT = path.join(os.tmpdir(), "speech2text-websocket");

await mkdir(TEMP_ROOT, { recursive: true });

const pendingJobs = [];
let currentJob = null;

const httpServer = createServer((req, res) => {
  void handleHttpRequest(req, res);
});

const wss = new WebSocketServer({ server: httpServer });

wss.on("connection", (socket, request) => {
  console.log(`client connected from ${request.socket.remoteAddress ?? "unknown"}`);

  const socketJobs = new Set();

  socket.on("message", (raw, isBinary) => {
    if (isBinary) {
      sendError(socket, "Binary WebSocket frames are not supported. Send JSON text messages.");
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

    let job;
    job = createTranscriptionJob({
      jobId: resolveJobId(message.id),
      audioBase64,
      language: resolveLanguage(message.language),
      onQueued(position) {
        sendJson(socket, {
          type: "queued",
          id: job.jobId,
          position,
        });
      },
      onStart({ id, model, language }) {
        sendJson(socket, {
          type: "start",
          id,
          model,
          language,
        });
      },
      onDelta({ id, text, fullText }) {
        sendJson(socket, {
          type: "delta",
          id,
          text,
          fullText,
        });
      },
      onDone(text) {
        sendJson(socket, {
          type: "done",
          id: job.jobId,
          text,
        });
      },
      onError(message) {
        sendJson(socket, {
          type: "error",
          id: job.jobId,
          message,
        });
      },
      onFinally() {
        socketJobs.delete(job);
      },
    });

    socketJobs.add(job);
    enqueueTranscriptionJob(job);
  });

  socket.on("close", () => {
    for (const job of socketJobs) {
      cancelJob(job);
    }

    console.log("client disconnected");
  });
});

httpServer.listen(PORT, HOST, () => {
  console.log(`speech2text backend listening on http://${HOST}:${PORT}`);
  console.log(`websocket endpoint available at ws://${HOST}:${PORT}`);
  console.log(`MCP endpoint available at https://${HOST}:${PORT}/mcp`);
  console.log(`using whisper model at ${MODEL_PATH}`);
});

async function handleHttpRequest(req, res) {
  try {
    setCorsHeaders(res);

    if (req.method === "OPTIONS") {
      res.writeHead(204);
      res.end();
      return;
    }

    const requestUrl = new URL(req.url ?? "/", `https://${req.headers.host ?? "localhost"}`);

    if (requestUrl.pathname === "/healthz") {
      sendJsonResponse(res, 200, { ok: true });
      return;
    }

    if (requestUrl.pathname === "/mcp") {
      await handleMcpHttpRequest(req, res);
      return;
    }

    sendJsonResponse(res, 404, { error: "Not found" });
  } catch (error) {
    console.error("HTTP request failed:", error);

    if (!res.headersSent) {
      sendJsonResponse(res, 500, { error: "Internal server error" });
    }
  }
}

async function handleMcpHttpRequest(req, res) {
  if (req.method !== "POST") {
    res.writeHead(405, { Allow: "POST", "content-type": "application/json" });
    res.end(
      JSON.stringify({
        jsonrpc: "2.0",
        error: {
          code: -32000,
          message: "Method not allowed.",
        },
        id: null,
      })
    );
    return;
  }

  let parsedBody;
  try {
    parsedBody = await readJsonBody(req);
  } catch (error) {
    res.writeHead(400, { "content-type": "application/json" });
    res.end(
      JSON.stringify({
        jsonrpc: "2.0",
        error: {
          code: -32700,
          message: error instanceof Error ? error.message : "Invalid JSON payload.",
        },
        id: null,
      })
    );
    return;
  }

  const mcpServer = buildMcpServer();
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
  });

  const cleanup = () => {
    void transport.close().catch((error) => {
      console.error("Failed to close MCP transport:", error);
    });
    void mcpServer.close().catch((error) => {
      console.error("Failed to close MCP server:", error);
    });
  };

  res.once("close", cleanup);

  try {
    await mcpServer.connect(transport);
    await transport.handleRequest(req, res, parsedBody);
  } catch (error) {
    console.error("Error handling MCP request:", error);

    if (!res.headersSent) {
      res.writeHead(500, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          jsonrpc: "2.0",
          error: {
            code: -32603,
            message: "Internal server error",
          },
          id: null,
        })
      );
    }
  }
}

function buildMcpServer() {
  const server = new McpServer(
    {
      name: "speech2text-http-mcp",
      version: "1.1.0",
    },
    {
      capabilities: {
        logging: {},
      },
    }
  );

  server.registerTool(
    "transcribe",
    {
      description:
        "Transcribe a base64-encoded webm/opus audio payload using whisper.cpp and return the final transcript text.",
      inputSchema: {
        type: z.literal("transcribe").describe("Must be 'transcribe'."),
        id: z.string().optional().describe("Optional request identifier."),
        language: z.string().default("auto").describe("Whisper language code, or 'auto'."),
        audio: z
          .string()
          .min(1)
          .describe("Base64 webm/opus audio payload or a data URL such as data:audio/webm;base64,..."),
      },
    },
    async ({ id, language, audio }) => {
      const transcript = await transcribeAudioOnce({
        jobId: resolveJobId(id),
        language,
        audioBase64: audio,
      });

      return {
        content: [
          {
            type: "text",
            text: transcript,
          },
        ],
      };
    }
  );

  return server;
}

async function readJsonBody(req) {
  const chunks = [];

  for await (const chunk of req) {
    chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
  }

  const rawBody = Buffer.concat(chunks).toString("utf8").trim();
  if (!rawBody) {
    throw new Error("Missing JSON request body.");
  }

  try {
    return JSON.parse(rawBody);
  } catch {
    throw new Error("Invalid JSON payload.");
  }
}

function sendJsonResponse(res, statusCode, payload) {
  res.writeHead(statusCode, { "content-type": "application/json" });
  res.end(JSON.stringify(payload));
}

function setCorsHeaders(res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader(
    "Access-Control-Allow-Headers",
    "Content-Type, Mcp-Session-Id, MCP-Protocol-Version"
  );
  res.setHeader("Access-Control-Allow-Methods", "POST, GET, DELETE, OPTIONS");
  res.setHeader("Access-Control-Expose-Headers", "Mcp-Session-Id");
}

function createTranscriptionJob({
  jobId,
  audioBase64,
  language = "auto",
  onQueued,
  onStart,
  onDelta,
  onDone,
  onError,
  onFinally,
}) {
  return {
    jobId,
    audioBase64,
    language,
    tracker: createJobTracker(jobId),
    onQueued,
    onStart,
    onDelta,
    onDone,
    onError,
    onFinally,
  };
}

function enqueueTranscriptionJob(job) {
  const queuePosition = pendingJobs.length + (currentJob ? 1 : 0);

  pendingJobs.push(job);

  if (queuePosition > 0) {
    job.onQueued?.(queuePosition);
  }

  void processQueue();

  return job;
}

function cancelJob(job) {
  job.tracker.cancelled = true;

  if (currentJob === job) {
    job.tracker.ffmpeg?.kill("SIGTERM");
    job.tracker.whisper?.kill("SIGTERM");
  } else {
    removePendingJob(job);
    job.onFinally?.();
  }
}

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

async function transcribeAudioOnce({ jobId, audioBase64, language = "auto" }) {
  return await new Promise((resolve, reject) => {
    enqueueTranscriptionJob(
      createTranscriptionJob({
        jobId,
        audioBase64,
        language,
        onDone(text) {
          resolve(text);
        },
        onError(message) {
          reject(new Error(message));
        },
      })
    );
  });
}

async function loadDotEnvFile(filePath) {
  try {
    const content = await readFile(filePath, "utf8");
    return parseDotEnv(content);
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
      return {};
    }

    throw error;
  }
}

function parseDotEnv(content) {
  const env = {};

  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) {
      continue;
    }

    const normalizedLine = line.startsWith("export ") ? line.slice(7) : line;
    const separatorIndex = normalizedLine.indexOf("=");
    if (separatorIndex <= 0) {
      continue;
    }

    const key = normalizedLine.slice(0, separatorIndex).trim();
    const value = normalizedLine.slice(separatorIndex + 1).trim();
    env[key] = stripWrappingQuotes(value);
  }

  return env;
}

function stripWrappingQuotes(value) {
  if (
    (value.startsWith('"') && value.endsWith('"')) ||
    (value.startsWith("'") && value.endsWith("'"))
  ) {
    return value.slice(1, -1);
  }

  return value;
}

function parsePort(value) {
  const port = Number.parseInt(value, 10);

  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`Invalid LDU_WHISPER_PORT value: ${value}`);
  }

  return port;
}

function resolveJobId(value) {
  return typeof value === "string" && value ? value : randomUUID();
}

function resolveLanguage(value) {
  return typeof value === "string" && value ? value : "auto";
}

async function processQueue() {
  if (currentJob || pendingJobs.length === 0) {
    return;
  }

  currentJob = pendingJobs.shift();
  const job = currentJob;

  job.onStart?.({
    id: job.jobId,
    model: MODEL_PATH,
    language: job.language,
  });

  try {
    const transcript = await transcribeAudio(job);

    if (!job.tracker.cancelled) {
      job.onDone?.(transcript);
    }
  } catch (error) {
    if (!job.tracker.cancelled) {
      job.onError?.(error instanceof Error ? error.message : String(error));
    }
  } finally {
    job.onFinally?.();
    currentJob = null;

    if (pendingJobs.length > 0) {
      setImmediate(() => {
        void processQueue();
      });
    }
  }
}

async function transcribeAudio(job) {
  const { jobId, audioBase64, language, tracker } = job;
  const jobDir = path.join(TEMP_ROOT, jobId);
  const inputPath = path.join(jobDir, "input.webm");
  const wavPath = path.join(jobDir, "input.wav");

  await mkdir(jobDir, { recursive: true });

  try {
    const audioBuffer = decodeBase64Audio(audioBase64);
    await writeFile(inputPath, audioBuffer);

    await convertWebmToWav({ inputPath, wavPath, tracker });
    if (tracker.cancelled) {
      return tracker.transcript.trim();
    }

    await runWhisper({ job, wavPath, language, tracker });
    return tracker.transcript.trim();
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

function removePendingJob(job) {
  const index = pendingJobs.indexOf(job);
  if (index >= 0) {
    pendingJobs.splice(index, 1);
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

function runWhisper({ job, wavPath, language, tracker }) {
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
      tracker.tail += chunk.toString("utf8");
      flushTranscript(job, false);
    });

    whisper.stderr.on("data", (chunk) => {
      stderr += chunk.toString("utf8");
    });

    whisper.on("error", (error) => {
      reject(new Error(`Failed to start whisper-cli: ${error.message}`));
    });

    whisper.on("close", (code) => {
      tracker.whisper = null;
      flushTranscript(job, true);

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

function flushTranscript(job, isFinalFlush) {
  const parsed = parseTranscript(job.tracker.tail, isFinalFlush);
  job.tracker.tail = parsed.remainder;

  if (!parsed.text) {
    return;
  }

  const separator =
    job.tracker.transcript &&
    !job.tracker.transcript.endsWith(" ") &&
    !parsed.text.startsWith("'")
      ? " "
      : "";
  const nextTranscript = `${job.tracker.transcript}${separator}${parsed.text}`;
  const delta = nextTranscript.slice(job.tracker.emittedLength);
  job.tracker.transcript = nextTranscript;
  job.tracker.emittedLength = nextTranscript.length;

  if (!delta) {
    return;
  }

  job.onDelta?.({
    id: job.jobId,
    text: delta,
    fullText: job.tracker.transcript.trimStart(),
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
