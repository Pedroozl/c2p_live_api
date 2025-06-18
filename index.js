import express from 'express';
import { createServer } from 'http';
import path from 'path';
import { fileURLToPath } from 'url';
import fs from 'fs';
import { spawn } from 'child_process';
import { WebSocketServer } from 'ws';
import cors from 'cors';
import NodeCache from 'node-cache';
import { randomUUID } from 'crypto';
import { start } from 'repl';
import * as pkg from "@prisma/client";
const { PrismaClient } = pkg;

const prisma = new PrismaClient();
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const app = express();
const api = express.Router();
const server = createServer(app);
const cache = new NodeCache({ stdTTL: 60, checkperiod: 120 });
const wss = new WebSocketServer({ server });

var usersSessions = {};

app.use(express.json());
app.use(cors({
  origin: '*',
}))
app.use(express.static(path.join(__dirname, 'public')));
app.use("/api", api);

api.get("/live/current", async (req, res) => {
  if (!cache.get("currentStream")) {
    var last = await prisma.streams.findFirst({
      where: {
        finished: true
      }
    })
    return res.status(206).json({
      current: false,
      message: "No live stream currently running.",
      last: last ?? null,
    });
  }
  const currentStream = cache.get("currentStream");
  return res.status(200).json({
    message: "Live stream is currently running.",
    current: true,
    data: {
      videoId: currentStream.videoId,
      hlsUrl: currentStream.hlsUrl,
      viewers: Object.keys(usersSessions).length,
      start_time: currentStream.start_time,
      end_time: currentStream.end_time,
      duration: currentStream.end_time ? (currentStream.end_time - currentStream.start_time) / 1000 : null,
    },
  });
})

api.get("/start-stream", async (req, res) => {
  var { videoId } = req.query;
  if (!videoId || typeof videoId !== "string") {
    return res.status(400).json({ error: "Missing or invalid videoId" });
  }

  const hlsDir = path.join(process.cwd(), "public", "hls");
  if (!fs.existsSync(hlsDir)) {
    fs.mkdirSync(hlsDir, { recursive: true });
  }

  try {
    const ytdlp = spawn("yt-dlp", [
      "-f",
      "95",
      "-o",
      "-",
      "--cookies",
      "cookies.txt",
      `https://www.youtube.com/watch?v=${videoId}`,
    ]);

    const ffmpeg = spawn("ffmpeg", [
      "-i",
      "pipe:0",
      "-c:v",
      "copy",
      "-c:a",
      "aac",
      "-f",
      "hls",
      "-hls_time",
      "5",
      "-hls_flags",
      "delete_segments",
      path.join(hlsDir, "index.m3u8"),
    ]);

    ytdlp.stdout.pipe(ffmpeg.stdin);

    ytdlp.stderr.on("data", (data) =>
      console.error("[yt-dlp]", data.toString())
    );

    ffmpeg.stderr.on("data", (data) =>
      console.error("[ffmpeg]", data.toString())
    );

    ytdlp.on("close", (code) => {
      console.log(`[yt-dlp] exited with code ${code}`);
    });

    ffmpeg.on("close", (code) => {
      console.log(`[ffmpeg] exited with code ${code}`);
    });

    var newstream = await prisma.streams.create({
      data: {
        title: `Live Stream - ${videoId}`,
        videoid: videoId,
        date: new Date(),
        start_time: new Date(),
        end_time: null,
        finished: false,
        started_by: 1,
        ended_by: null,
      }
    })
    console.log(`Stream started for videoId: ${videoId}`);
    cache.set("currentStream", newstream, 0)
    usersSessions = {};
    wss.clients.forEach((client) => {
      if (client.readyState === client.OPEN) {
        client.send(JSON.stringify({
          op: "STREAM_START",
          d: newstream,
          t: new Date().getTime(),
        }));
      }
    })
    return res.status(200).json(
      { message: "Transmissão iniciada com sucesso." }
    );
  } catch (error) {
    return res.status(500).json(
      { error: "Erro ao iniciar retransmissão.", details: error }
    );
  }
})

wss.on('connection', (ws) => {
  ws.on("open", () => {
    console.log("WebSocket connection opened");
    ws.send(JSON.stringify({
      op: "RE_HANDSHAKE",
      d: {
        message: "Session not found",
      },
      t: t,
    }));
  })

  ws.on('message', (message) => {
    message = message.toString();
    message = JSON.parse(message);

    var { op, t, d } = message;

    switch (op) {
      case "HANDSHAKE":
        var id = randomUUID()
        if (!usersSessions[ws._socket.remoteAddress]) {
          usersSessions[id] = {
            id: id,
            ws: ws,
            first_heartbeat: new Date().getTime(),
            last_heartbeat: new Date().getTime(),
            next_heartbeat: new Date().getTime() + 6000
          }
        }
        ws.send(JSON.stringify({
          op: "HANDSHAKE",
          t: t,
          d: {
            session: id,
          }
        }));
        var cac = null
        if (cache.get("currentStream")) {
          cac = cache.get("currentStream");
          cac.viewers = Object.keys(usersSessions).length;
        }
        ws.send(JSON.stringify({
          op: "HELLO",
          d: cac || null,
          t: new Date().getTime(),
        }))
        break;
      case "PING":
        if (d.session) {
          if (usersSessions[d.session]) {
            usersSessions[d.session].next_heartbeat = new Date().getTime() + 6000;
            usersSessions[d.session].last_heartbeat = new Date().getTime();
            usersSessions[d.session].ws = ws;
            var aa = {...usersSessions[d.session]}
            delete aa.ws
            ws.send(JSON.stringify({
              op: "PONG",
              d: aa,
              t: new Date().getTime(),
            }));
          } else {
            console.error("Session not found:", d.session);
            ws.send(JSON.stringify({
              op: "RE_HANDSHAKE",
              d: {
                message: "Session not found",
              },
              t: t,
            }));
          }
        }
        break;
    }
  });

  ws.on('close', () => {
    console.log('WebSocket connection closed');
  });
});

//aa
setInterval(() => {
  for (var sessionId in usersSessions) {
    const session = usersSessions[sessionId];
    if (session && new Date().getTime() > session.next_heartbeat) {
      session.ws.send(JSON.stringify({
        op: "RE_HANDSHAKE",
        d: {
          message: "Session not found",
        },
        t: new Date().getTime(),
      }));
      delete usersSessions[sessionId];
      console.log(`Session ${sessionId} expired and removed.`);
    }
  }
  if (cache.get("currentStream")) {
    const currentStream = cache.get("currentStream");
    currentStream.viewers = Object.keys(usersSessions).length;
    wss.clients.forEach((client) => {
      if (client.readyState === client.OPEN) {
        var eca = cache.get("currentStream");
        if (eca) {
          eca.viewers = Object.keys(usersSessions).length;
        }
        client.send(JSON.stringify({
          op: "STREAM_UPDATE",
          d: eca || null,
          t: new Date().getTime(),
        }));
      }
    });
  }
}, 4000)

server.listen(5001, () => {
  console.log('Server is running on port 5001');
})