import crypto from "node:crypto";
import fs from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";

import dotenv from "dotenv";
import express from "express";
import { WebSocketServer, WebSocket } from "ws";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

dotenv.config({ path: path.join(__dirname, ".env") });

const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: "/ws/asr" });
const transcriptDir = process.env.TRANSCRIPT_DIR || path.join(process.env.HOME || __dirname, "Documents", "Realtime Transcriber");
const transcriptMetaDir = path.join(transcriptDir, ".metadata");

const port = Number(process.env.PORT || 5178);
const defaultModel = process.env.ASR_MODEL || "fun-asr-realtime";
const defaultPricePerSecond = Number(process.env.ASR_PRICE_PER_SECOND || 0.00033);
const apiKey = process.env.DASHSCOPE_API_KEY || process.env.BAILIAN_API_KEY;
const workspaceId = process.env.BAILIAN_WORKSPACE_ID || process.env.DASHSCOPE_WORKSPACE_ID || "";
const dashscopeWsUrl =
  process.env.DASHSCOPE_WS_URL ||
  (workspaceId
    ? `wss://${workspaceId}.cn-beijing.maas.aliyuncs.com/api-ws/v1/inference`
    : "wss://dashscope.aliyuncs.com/api-ws/v1/inference");

app.use(express.json({ limit: "1mb" }));
app.use(express.static(path.join(__dirname, "public")));

app.get("/api/config", (_req, res) => {
  res.json({
    ok: Boolean(apiKey),
    model: defaultModel,
    pricePerSecond: defaultPricePerSecond,
    currency: "CNY",
    endpoint: workspaceId ? "workspace" : "dashscope",
    transcriptDir,
  });
});

app.post("/api/save-transcript", async (req, res) => {
  const text = String(req.body?.text || "").trim();
  if (!text) {
    res.status(400).json({ ok: false, message: "没有可保存的识别文字。" });
    return;
  }

  const sessionId = String(req.body?.sessionId || crypto.randomUUID()).replace(/[^a-zA-Z0-9-]/g, "");
  const shortId = sessionId.slice(0, 8) || crypto.randomUUID().slice(0, 8);
  const baseName = `session-${shortId}`;
  const txtPath = path.join(transcriptDir, `${baseName}.txt`);
  const metaPath = path.join(transcriptMetaDir, `${baseName}.json`);
  const metadata = {
    createdAt: new Date().toISOString(),
    sessionId,
    model: req.body?.model || defaultModel,
    durationMs: Number(req.body?.durationMs || 0),
    estimatedCost: Number(req.body?.estimatedCost || 0),
    currency: "CNY",
    textFile: txtPath,
  };

  await fs.mkdir(transcriptDir, { recursive: true });
  await fs.mkdir(transcriptMetaDir, { recursive: true });
  await fs.writeFile(txtPath, `${text}\n`, "utf8");
  await fs.writeFile(metaPath, `${JSON.stringify(metadata, null, 2)}\n`, "utf8");

  res.json({
    ok: true,
    file: txtPath,
    metaFile: metaPath,
  });
});

wss.on("connection", (client) => {
  let upstream = null;
  let taskId = crypto.randomUUID();
  let upstreamReady = false;
  let taskStarted = false;
  let closed = false;
  let model = defaultModel;

  const sendClient = (payload) => {
    if (client.readyState === WebSocket.OPEN) {
      client.send(JSON.stringify(payload));
    }
  };

  const closeUpstream = () => {
    if (!upstream || upstream.readyState !== WebSocket.OPEN) return;
    upstream.send(
      JSON.stringify({
        header: {
          action: "finish-task",
          task_id: taskId,
          streaming: "duplex",
        },
        payload: {
          input: {},
        },
      }),
    );
    setTimeout(() => upstream?.close(), 800);
  };

  const connectUpstream = () => {
    if (!apiKey) {
      sendClient({
        type: "error",
        message: "缺少 BAILIAN_API_KEY 或 DASHSCOPE_API_KEY，请检查 .env。",
      });
      return;
    }

    upstream = new WebSocket(dashscopeWsUrl, {
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "user-agent": "jack-realtime-transcriber/0.1",
        ...(workspaceId ? { "X-DashScope-WorkSpace": workspaceId } : {}),
      },
    });

    upstream.on("open", () => {
      upstreamReady = true;
      taskId = crypto.randomUUID();
      upstream.send(
        JSON.stringify({
          header: {
            action: "run-task",
            task_id: taskId,
            streaming: "duplex",
          },
          payload: {
            task_group: "audio",
            task: "asr",
            function: "recognition",
            model,
            parameters: {
              format: "pcm",
              sample_rate: 16000,
              disfluency_removal_enabled: false,
              language_hints: ["zh"],
            },
            input: {},
          },
        }),
      );
      sendClient({ type: "upstream-open", model });
    });

    upstream.on("message", (data) => {
      let event;
      try {
        event = JSON.parse(data.toString());
      } catch {
        sendClient({ type: "raw", data: data.toString() });
        return;
      }

      const name = event?.header?.event;
      if (name === "task-started") {
        taskStarted = true;
        sendClient({ type: "ready" });
      }

      if (name === "result-generated") {
        const sentence = event?.payload?.output?.sentence || {};
        sendClient({
          type: "result",
          text: sentence.text || "",
          sentenceEnd: Boolean(sentence.sentence_end),
          beginTime: sentence.begin_time ?? null,
          endTime: sentence.end_time ?? null,
          usage: event?.payload?.usage || null,
        });
        return;
      }

      if (name === "task-failed") {
        sendClient({
          type: "error",
          message: event?.payload?.message || event?.header?.error_message || "阿里云识别任务失败。",
          detail: event,
        });
        return;
      }

      if (name === "task-finished") {
        sendClient({ type: "finished" });
        upstream?.close();
        return;
      }

      sendClient({ type: "event", event });
    });

    upstream.on("error", (error) => {
      sendClient({ type: "error", message: `阿里云 WebSocket 错误：${error.message}` });
    });

    upstream.on("close", (code, reason) => {
      upstreamReady = false;
      taskStarted = false;
      if (!closed) {
        sendClient({
          type: "upstream-close",
          code,
          reason: reason?.toString() || "",
        });
      }
    });
  };

  client.on("message", (data, isBinary) => {
    if (isBinary) {
      if (upstreamReady && taskStarted && upstream?.readyState === WebSocket.OPEN) {
        upstream.send(data, { binary: true });
      }
      return;
    }

    let message;
    try {
      message = JSON.parse(data.toString());
    } catch {
      sendClient({ type: "error", message: "前端消息不是有效 JSON。" });
      return;
    }

    if (message.type === "start") {
      model = message.model || defaultModel;
      connectUpstream();
      return;
    }

    if (message.type === "stop") {
      closeUpstream();
    }
  });

  client.on("close", () => {
    closed = true;
    closeUpstream();
  });
});

server.listen(port, () => {
  console.log(`Realtime transcriber: http://localhost:${port}`);
});
