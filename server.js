import express from "express";
import fetch from "node-fetch";
import dotenv from "dotenv";
import fs from "fs";
import path from "path";
import os from "node:os";
import { exec } from "child_process";
import util from "util";  // ✅ Added for promisified exec
import ffmpegPath from "ffmpeg-static";
import { spawn } from "child_process";


dotenv.config();
const app = express();
const PORT = process.env.PORT || 3000;
const API_KEY = process.env.GOOGLE_API_KEY;
const execPromise = util.promisify(exec); // ✅ for async ffmpeg commands

if (!API_KEY) {
  console.error("❌ Missing GOOGLE_API_KEY in .env file");
  process.exit(1);
}

app.use(express.static("public"));
app.use(express.json()); // ✅ Added for JSON parsing (needed for POST /trim)

// Track last downloaded temp file
let lastTempFile = null;


// Small concurrency gate (avoid 2 encodes at once on small plans)
let inFlight = 0;
const MAX_JOBS = 1;
async function gate() {
  while (inFlight >= MAX_JOBS) {
    await new Promise(r => setTimeout(r, 100));
  }
  inFlight++;
  return () => { inFlight--; };
}

function spawnFfmpeg(args) {
  const bin = process.env.FFMPEG_PATH || ffmpegPath;
  return spawn(bin, args, { stdio: ["ignore", "pipe", "pipe"] });
}

// Stream a finished file to client (no readFileSync) and unlink afterwards
function streamAndUnlink(filePath, res, { inline = false, filename = "trimmed_video.mp4" } = {}) {
  const headers = { "Content-Type": "video/mp4" };
  if (!inline) headers["Content-Disposition"] = `attachment; filename="${filename}"`;
  res.writeHead(200, headers);
  const read = fs.createReadStream(filePath);
  read.pipe(res);
  const cleanup = () => fs.unlink(filePath, () => {});
  read.on("close", cleanup);
  read.on("error", (e) => { console.error("Stream error:", e); cleanup(); try { res.end(); } catch {} });
  res.on("close", cleanup);
}

// For previews: pipe ffmpeg -> client directly (lowest RAM)
function pipeFfmpegToResponse({ srcPath, startSec, duration, precise, previewQuality = true }, res) {
  const args = precise
    ? [
        "-nostdin",
        "-i", srcPath,
        "-ss", String(startSec),
        "-t",  String(duration),
        "-map", "0",
        "-c:v", "libx264",
        "-preset", previewQuality ? "ultrafast" : "veryfast",
        "-crf",   previewQuality ? "26" : "20",
        "-c:a", "aac", "-b:a", previewQuality ? "96k" : "192k",
        "-threads", "1",
        "-movflags", "frag_keyframe+empty_moov+faststart",
        "-pix_fmt", "yuv420p",
        "-f", "mp4", "-"
      ]
    : [
        "-nostdin",
        "-ss", String(startSec),
        "-t",  String(duration),
        "-i", srcPath,
        "-map", "0",
        "-c", "copy",
        "-threads", "1",
        "-movflags", "frag_keyframe+empty_moov+faststart",
        "-f", "mp4", "-"
      ];

  const ff = spawnFfmpeg(args);

  res.writeHead(200, {
    "Content-Type": "video/mp4",
    "Transfer-Encoding": "chunked",
    "Cache-Control": "no-store"
  });

  let err = "";
  ff.stdout.pipe(res);
  ff.stderr.on("data", d => (err += d.toString()));
  ff.on("close", (code) => {
    if (code !== 0) {
      console.error("ffmpeg failed:", err || `code ${code}`);
      if (!res.headersSent) res.status(500).send("ffmpeg error");
      else try { res.end(); } catch {}
      return;
    }
    try { res.end(); } catch {}
  });

  // If client disconnects, kill ffmpeg
  res.on("close", () => { try { ff.kill("SIGKILL"); } catch {} });
}



// -------------------------
// Helper: normalize times (supports seconds or milliseconds)
// - Re-encode ONLY if:
//   * ms are actually non-zero, OR
//   * seconds include fractional part
// -------------------------
function normalizeTimes({ start, end, startMs, endMs }) {
  // parse seconds or ms->s
  const s = (start !== undefined && start !== null)
    ? parseFloat(start)
    : (startMs !== undefined && startMs !== null)
      ? parseFloat(startMs) / 1000
      : NaN;

  const e = (end !== undefined && end !== null)
    ? parseFloat(end)
    : (endMs !== undefined && endMs !== null)
      ? parseFloat(endMs) / 1000
      : NaN;

  if (!Number.isFinite(s) || !Number.isFinite(e)) {
    throw new Error("Invalid start/end time.");
  }
  if (e <= s) throw new Error("End time must be after start time.");

  // round to ms precision for ffmpeg
  const startSec = +s.toFixed(3);
  const endSec   = +e.toFixed(3);
  const duration = +(endSec - startSec).toFixed(3);

  // detect if ms actually matter (non-zero)
  const sm = (startMs !== undefined && startMs !== null) ? parseInt(startMs, 10) : null;
  const em = (endMs   !== undefined && endMs   !== null) ? parseInt(endMs,   10) : null;
  const msNonZero =
    (sm !== null && (sm % 1000) !== 0) ||
    (em !== null && (em % 1000) !== 0);

  // also re-encode if seconds include fractional part
  const hasFraction = (startSec % 1 !== 0) || (endSec % 1 !== 0);

  // ✅ only force precise when needed
  const forcePrecise = msNonZero || hasFraction;

  return { startSec, duration, forcePrecise };
}



// -------------------------
// Automatic cleanup of old temp videos
// -------------------------
function cleanupTempFiles() {
  const tmpDir = os.tmpdir();
  const videoExts = [".mp4", ".mov", ".avi", ".mkv", ".webm"];
  let videosFound = false;

  fs.readdir(tmpDir, (err, files) => {
    if (err) return console.error("Error reading temp directory:", err);

    files.forEach((file) => {
      const ext = path.extname(file).toLowerCase();
      if (videoExts.includes(ext)) {
        videosFound = true;
        const filePath = path.join(tmpDir, file);
        fs.unlink(filePath, (err) => {
          if (err) console.error("Failed to delete old temp video:", filePath);
          else console.log("Deleted old temp video:", filePath);
        });
      }
    });

    if (!videosFound) console.log("No temp videos found to delete.");
    else console.log("Temp video cleanup complete.");
  });
}

// Run cleanup on server startup
cleanupTempFiles();

// -------------------------
// Helper: get metadata
// -------------------------
async function getFileMetadata(fileId) {
  const metaUrl = `https://www.googleapis.com/drive/v3/files/${fileId}?fields=size,mimeType,name&key=${API_KEY}`;
  const res = await fetch(metaUrl);
  const meta = await res.json();
  if (!meta.size) throw new Error("Cannot access file metadata (make sure file is public).");
  return { size: parseInt(meta.size, 10), mimeType: meta.mimeType || "video/mp4", name: meta.name };
}

// -------------------------
// Download file to temp directory
// -------------------------
async function downloadFile(fileId, filePath) {
  const url = `https://www.googleapis.com/drive/v3/files/${fileId}?alt=media&key=${API_KEY}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error("Failed to download file from Google Drive");

  const fileStream = fs.createWriteStream(filePath);
  await new Promise((resolve, reject) => {
    res.body.pipe(fileStream);
    res.body.on("error", reject);
    fileStream.on("finish", resolve);
  });
}

// -------------------------
// Stream file with range support
// -------------------------
function streamFile(req, res, filePath, mimeType) {
  const stat = fs.statSync(filePath);
  const fileSize = stat.size;
  const range = req.headers.range;

  if (range) {
    const parts = range.replace(/bytes=/, "").split("-");
    const start = parseInt(parts[0], 10);
    const end = parts[1] ? parseInt(parts[1], 10) : fileSize - 1;
    const chunkSize = end - start + 1;
    const stream = fs.createReadStream(filePath, { start, end });

    res.writeHead(206, {
      "Content-Range": `bytes ${start}-${end}/${fileSize}`,
      "Accept-Ranges": "bytes",
      "Content-Length": chunkSize,
      "Content-Type": mimeType,
    });
    stream.pipe(res);
  } else {
    res.writeHead(200, {
      "Content-Length": fileSize,
      "Content-Type": mimeType,
    });
    fs.createReadStream(filePath).pipe(res);
  }
}

// -------------------------
// Main video route
// -------------------------
app.get("/video/:fileId", async (req, res) => {
  try {
    const { fileId } = req.params;
    const { size, mimeType, name } = await getFileMetadata(fileId);
    const localPath = path.join(os.tmpdir(), name);

    if (size > 100 * 1024 * 1024) {
      // Large file: download to temp
      if (lastTempFile && lastTempFile !== localPath && fs.existsSync(lastTempFile)) {
        fs.unlink(lastTempFile, (err) => {
          if (err) console.error("Failed to delete previous temp file:", err);
          else console.log("Deleted previous temp file:", lastTempFile);
        });
      }

      if (!fs.existsSync(localPath)) {
        console.log("Downloading large file to temp directory...");
        await downloadFile(fileId, localPath);
        console.log("Download complete.");
      }

      lastTempFile = localPath;
      return streamFile(req, res, localPath, mimeType);
    } else {
      // Small file: stream directly from Drive
      const videoUrl = `https://www.googleapis.com/drive/v3/files/${fileId}?alt=media&key=${API_KEY}`;
      const headers = req.headers.range ? { Range: req.headers.range } : {};
      const videoRes = await fetch(videoUrl, { headers });

      res.writeHead(videoRes.status, {
        "Content-Type": mimeType,
        ...Object.fromEntries(videoRes.headers.entries()),
      });

      return videoRes.body.pipe(res);
    }
  } catch (err) {
    console.error(err);
    res.status(500).send("❌ " + err.message);
  }
});

// -------------------------
// ✅ Trim video route (ms-accurate when ms provided)
// -------------------------
app.post("/trim", async (req, res) => {
  const { fileId, start, end, startMs, endMs, preview, mode } = req.body; // mode: "precise"|"copy" (optional)
  if (!fileId) return res.status(400).send("Missing fileId.");

  const release = await gate(); // limit concurrent encodes
  try {
    const { name } = await getFileMetadata(fileId);
    const srcPath = path.join(os.tmpdir(), name);

    if (!fs.existsSync(srcPath)) {
      console.log("Downloading source file for trimming...");
      await downloadFile(fileId, srcPath);
    }

    const { startSec, duration, forcePrecise } = normalizeTimes({ start, end, startMs, endMs });
    const precise = forcePrecise || mode === "precise"; // only re-encode when needed/forced

    // ✅ PREVIEW: stream directly from ffmpeg (no temp file, no RAM spike)
    if (preview) {
      pipeFfmpegToResponse({ srcPath, startSec, duration, precise, previewQuality: true }, res);
      return;
    }

    // ✅ DOWNLOAD: write to /tmp, then stream file (no readFileSync)
    const outPath = path.join(os.tmpdir(), `trimmed_${Date.now()}.mp4`);
    const args = precise
      ? [
          "-nostdin",
          "-i", srcPath,
          "-ss", String(startSec),
          "-t",  String(duration),
          "-map", "0",
          "-c:v", "libx264", "-preset", "veryfast", "-crf", "20",
          "-c:a", "aac", "-b:a", "192k",
          "-threads", "1",
          "-movflags", "+faststart",
          "-pix_fmt", "yuv420p",
          "-y", outPath
        ]
      : [
          "-nostdin",
          "-ss", String(startSec),
          "-t",  String(duration),
          "-i", srcPath,
          "-map", "0",
          "-c", "copy",
          "-threads", "1",
          "-movflags", "+faststart",
          "-y", outPath
        ];

    console.log("ffmpeg", args.join(" "));
    await new Promise((resolve, reject) => {
      const ff = spawnFfmpeg(args);
      let err = "";
      ff.stderr.on("data", d => (err += d.toString()));
      ff.on("close", code => (code === 0 ? resolve() : reject(new Error(err || `code ${code}`))));
    });

    // Stream file to client and unlink afterwards
    streamAndUnlink(outPath, res, { inline: false, filename: "trimmed_video.mp4" });
  } catch (err) {
    console.error(err);
    res.status(500).send("❌ Failed to trim video: " + err.message);
  } finally {
    release();
  }
});



// ✅ GET version (supports ms via startMs/endMs)
app.get("/trim", async (req, res) => {
  const { fileId, start, end, startMs, endMs, mode } = req.query;
  if (!fileId) return res.status(400).send("Missing fileId.");

  const release = await gate(); // limit concurrent encodes
  try {
    const { name } = await getFileMetadata(fileId);
    const srcPath = path.join(os.tmpdir(), name);

    if (!fs.existsSync(srcPath)) {
      console.log("Downloading file for trim...");
      await downloadFile(fileId, srcPath);
    }

    const { startSec, duration, forcePrecise } = normalizeTimes({ start, end, startMs, endMs });
    const precise = forcePrecise || mode === "precise";
    const outPath = path.join(os.tmpdir(), `trimmed_${Date.now()}.mp4`);

    const args = precise
      ? [
          "-nostdin",
          "-i", srcPath,
          "-ss", String(startSec),
          "-t",  String(duration),
          "-map", "0",
          "-c:v", "libx264", "-preset", "veryfast", "-crf", "20",
          "-c:a", "aac", "-b:a", "192k",
          "-threads", "1",
          "-movflags", "+faststart",
          "-pix_fmt", "yuv420p",
          "-y", outPath
        ]
      : [
          "-nostdin",
          "-ss", String(startSec),
          "-t",  String(duration),
          "-i", srcPath,
          "-map", "0",
          "-c", "copy",
          "-threads", "1",
          "-movflags", "+faststart",
          "-y", outPath
        ];

    console.log("ffmpeg", args.join(" "));
    await new Promise((resolve, reject) => {
      const ff = spawnFfmpeg(args);
      let err = "";
      ff.stderr.on("data", d => (err += d.toString()));
      ff.on("close", code => (code === 0 ? resolve() : reject(new Error(err || `code ${code}`))));
    });

    // Stream file to client and unlink afterwards
    streamAndUnlink(outPath, res, { inline: false, filename: "trimmed_video.mp4" });
  } catch (err) {
    console.error(err);
    res.status(500).send("❌ Failed to trim video: " + err.message);
  } finally {
    release();
  }
});



app.listen(PORT, () => console.log(`✅ Server running at http://localhost:${PORT}`));
