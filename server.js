import express from "express";
import fetch from "node-fetch";
import dotenv from "dotenv";
import fs from "fs";
import path from "path";
import os from "node:os";
import { exec } from "child_process";
import util from "util";  // ✅ promisified exec

dotenv.config();
const app = express();
const PORT = process.env.PORT || 3000;
const API_KEY = process.env.GOOGLE_API_KEY;
const execPromise = util.promisify(exec);

if (!API_KEY) {
  console.error("❌ Missing GOOGLE_API_KEY in .env file");
  process.exit(1);
}

app.use(express.static("public"));
app.use(express.json());

// Track last downloaded temp file
let lastTempFile = null;

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
cleanupTempFiles();


// -------- Render/cache toggles --------
const DISABLE_LOCAL_CACHE = process.env.DISABLE_LOCAL_CACHE === "1" || !!process.env.RENDER;

// verify a local file is complete (matches Drive size)
function isCompleteFile(p, expectedSize) {
  try {
    const st = fs.statSync(p);
    return st.size === expectedSize;
  } catch {
    return false;
  }
}


// -------------------------
// Helpers: ms + cache + accurate ffmpeg
// -------------------------
function msToTimestamp(ms) {
  const sign = ms < 0 ? "-" : "";
  ms = Math.max(0, Math.abs(ms));
  const hh  = Math.floor(ms / 3600000);
  const mm  = Math.floor((ms % 3600000) / 60000);
  const ss  = Math.floor((ms % 60000) / 1000);
  const mmm = ms % 1000;
  const pad = (n, l = 2) => String(n).padStart(l, "0");
  return `${sign}${pad(hh)}:${pad(mm)}:${pad(ss)}.${pad(mmm,3)}`;
}

function safeName(name) {
  return name.replace(/[^a-zA-Z0-9._-]+/g, "_");
}
function cachePathFor(fileId, name) {
  return path.join(os.tmpdir(), `${fileId}_${safeName(name)}`);
}

// Accurate, millisecond-precise trim command
function ffmpegAccurateCmd(input, startTS, durTS, outPath, preset = "veryfast", crf = 18, audioBitrate = "192k") {
  return [
    `ffmpeg -hide_banner -loglevel error`,
    `-i "${input}"`,          // accurate seek: -ss AFTER -i
    `-ss ${startTS}`,
    `-t ${durTS}`,
    `-c:v libx264 -preset ${preset} -crf ${crf}`,
    `-c:a aac -b:a ${audioBitrate}`,
    `-movflags +faststart`,
    `-y "${outPath}"`
  ].join(" ");
}

// Parse times from request (ms preferred; supports seconds or HH:MM:SS.mmm)
function parseTimeInputs(q) {
  if (q.startMs != null && q.endMs != null) {
    const startMs = Number(q.startMs);
    const endMs   = Number(q.endMs);
    if (!Number.isFinite(startMs) || !Number.isFinite(endMs)) {
      throw new Error("Invalid millisecond values.");
    }
    return { startMs, endMs };
  }
  const isNum = (v) => v != null && /^\d+(\.\d+)?$/.test(String(v));
  if (isNum(q.start) && isNum(q.end)) {
    const startMs = Math.round(parseFloat(q.start) * 1000);
    const endMs   = Math.round(parseFloat(q.end) * 1000);
    return { startMs, endMs };
  }
  if (q.start && q.end) {
    const toMs = (ts) => {
      const m = String(ts).trim().match(/^(\d+):([0-5]?\d):([0-5]?\d)(?:\.(\d{1,3}))?$/);
      if (!m) throw new Error("Bad timestamp. Use HH:MM:SS.mmm");
      const [_, hh, mm, ss, ms] = m;
      return (+hh) * 3600000 + (+mm) * 60000 + (+ss) * 1000 + +(ms || 0);
    };
    return { startMs: toMs(q.start), endMs: toMs(q.end) };
  }
  throw new Error("Missing parameters.");
}

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
// Download file and verify size matches Drive
async function downloadFile(fileId, filePath, expectedSize) {
  const url = `https://www.googleapis.com/drive/v3/files/${fileId}?alt=media&key=${API_KEY}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error("Failed to download file from Google Drive");

  await new Promise((resolve, reject) => {
    const ws = fs.createWriteStream(filePath);
    res.body.pipe(ws);
    res.body.on("error", reject);
    ws.on("finish", resolve);
  });

  // verify and nuke partials
  if (!isCompleteFile(filePath, expectedSize)) {
    try { fs.unlinkSync(filePath); } catch {}
    throw new Error("Partial download detected (size mismatch).");
  }
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
    const localPath = cachePathFor(fileId, name);

    // If caching is disabled (e.g., on Render), always stream over HTTP
    if (DISABLE_LOCAL_CACHE) {
      const videoUrl = `https://www.googleapis.com/drive/v3/files/${fileId}?alt=media&key=${API_KEY}`;
      const headers = req.headers.range ? { Range: req.headers.range } : {};
      const videoRes = await fetch(videoUrl, { headers });
      res.writeHead(videoRes.status, {
        "Content-Type": mimeType,
        ...Object.fromEntries(videoRes.headers.entries()),
      });
      return videoRes.body.pipe(res);
    }

    // Otherwise, cache large files locally (but verify size to avoid partials)
    if (size > 100 * 1024 * 1024) {
      if (lastTempFile && lastTempFile !== localPath && fs.existsSync(lastTempFile)) {
        fs.unlink(lastTempFile, (err) => {
          if (err) console.error("Failed to delete previous temp file:", err);
          else console.log("Deleted previous temp file:", lastTempFile);
        });
      }

      if (!isCompleteFile(localPath, size)) {
        console.log("Downloading large file to temp directory...");
        await downloadFile(fileId, localPath, size);
        console.log("Download complete.");
      }

      lastTempFile = localPath;
      return streamFile(req, res, localPath, mimeType);
    }

    // Small files: stream directly from Drive
    const videoUrl = `https://www.googleapis.com/drive/v3/files/${fileId}?alt=media&key=${API_KEY}`;
    const headers = req.headers.range ? { Range: req.headers.range } : {};
    const videoRes = await fetch(videoUrl, { headers });
    res.writeHead(videoRes.status, {
      "Content-Type": mimeType,
      ...Object.fromEntries(videoRes.headers.entries()),
    });
    return videoRes.body.pipe(res);
  } catch (err) {
    console.error(err);
    res.status(500).send("❌ " + err.message);
  }
});



// -------------------------
// ✅ Trim video route (Preview: accurate; Download: accurate)
// -------------------------
app.post("/trim", async (req, res) => {
  const { fileId, preview } = req.body;
  if (!fileId) return res.status(400).send("Missing parameters.");

  try {
    const { name, size } = await getFileMetadata(fileId);
    const srcPath = cachePathFor(fileId, name);
    const inputUrl = `https://www.googleapis.com/drive/v3/files/${fileId}?alt=media&key=${API_KEY}`;
  
    // Choose input: on Render (or disabled cache) use HTTP; otherwise use verified local file
    let inputForFfmpeg;
    if (DISABLE_LOCAL_CACHE) {
      inputForFfmpeg = inputUrl;
    } else if (!isCompleteFile(srcPath, size)) {
      if (!preview) {
        console.log("Downloading source file for trimming...");
        await downloadFile(fileId, srcPath, size);
        inputForFfmpeg = srcPath;
      } else {
        console.log("Using HTTP input for preview (no local cache).");
        inputForFfmpeg = inputUrl;
      }
    } else {
      inputForFfmpeg = srcPath;
    }
  

    // Parse time (ms preferred)
    const { startMs, endMs } = parseTimeInputs(req.body);
    if (!(endMs > startMs)) throw new Error("End must be after start.");

    const startTS = msToTimestamp(startMs);
    const durTS   = msToTimestamp(endMs - startMs);

    const outPath = path.join(os.tmpdir(), `trimmed_${Date.now()}.mp4`);

    // Preview: accurate seek & re-encode (ultrafast to stay snappy)
    const cmd = ffmpegAccurateCmd(inputForFfmpeg, startTS, durTS, outPath, "ultrafast", 20, "160k");
    console.log("Running:", cmd);
    await execPromise(cmd);

    if (preview) {
      const buffer = fs.readFileSync(outPath);
      res.setHeader("Content-Type", "video/mp4");
      res.send(buffer);
      fs.unlink(outPath, () => {});
    } else {
      res.download(outPath, "trimmed_video.mp4", () => fs.unlink(outPath, () => {}));
    }
  } catch (err) {
    console.error(err);
    res.status(500).send("❌ Failed to trim video: " + err.message);
  }
});

// ✅ GET version for direct downloads (accurate, matches preview exactly)
app.get("/trim", async (req, res) => {
  const { fileId } = req.query;
  if (!fileId) return res.status(400).send("Missing parameters.");

  try {
    const { name, size } = await getFileMetadata(fileId);
    const srcPath = cachePathFor(fileId, name);
    const inputUrl = `https://www.googleapis.com/drive/v3/files/${fileId}?alt=media&key=${API_KEY}`;
  
    let inputForFfmpeg;
    if (DISABLE_LOCAL_CACHE) {
      inputForFfmpeg = inputUrl;
    } else if (!isCompleteFile(srcPath, size)) {
      console.log("Downloading file for trim...");
      await downloadFile(fileId, srcPath, size);
      inputForFfmpeg = srcPath;
    } else {
      inputForFfmpeg = srcPath;
    }
  
    const { startMs, endMs } = parseTimeInputs(req.query);
    if (!(endMs > startMs)) throw new Error("End must be after start.");
  
    const startTS = msToTimestamp(startMs);
    const durTS   = msToTimestamp(endMs - startMs);
  
    const outPath = path.join(os.tmpdir(), `trimmed_${Date.now()}.mp4`);
  
    // Accurate cut (matches preview exactly), better quality for downloads
    const cmd = ffmpegAccurateCmd(inputForFfmpeg, startTS, durTS, outPath, "veryfast", 18, "192k");
    console.log("Running:", cmd);
    await execPromise(cmd);
  

    res.download(outPath, "trimmed_video.mp4", () => fs.unlink(outPath, () => {}));
  } catch (err) {
    console.error(err);
    res.status(500).send("❌ Failed to trim video: " + err.message);
  }
});

app.listen(PORT, () => console.log(`✅ Server running at http://localhost:${PORT}`));
