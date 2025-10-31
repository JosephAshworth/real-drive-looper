import express from "express";
import fetch from "node-fetch";
import dotenv from "dotenv";
import fs from "fs";
import path from "path";
import os from "node:os";
import { exec } from "child_process";
import util from "util";  // ✅ Added for promisified exec

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



// ---- Millisecond helpers ----
function msToTimestamp(ms) {
  const sign = ms < 0 ? "-" : "";
  ms = Math.max(0, Math.abs(ms));
  const hh  = Math.floor(ms / 3600000);
  const mm  = Math.floor((ms % 3600000) / 60000);
  const ss  = Math.floor((ms % 60000) / 1000);
  const mmm = ms % 1000;
  const pad = (n, l = 2) => String(n).padStart(l, "0");
  return `${sign}${pad(hh)}:${pad(mm)}:${pad(ss)}.${pad(mmm, 3)}`;
}



function safeName(name) {
  return name.replace(/[^a-zA-Z0-9._-]+/g, "_");
}



function cachePathFor(fileId, name) {
  return path.join(os.tmpdir(), `${fileId}_${safeName(name)}`);
}

// ✅ Accurate, millisecond-precise trim command
function ffmpegAccurateCmd(input, startTS, durTS, outPath, preset = "veryfast", crf = 18, audioBitrate = "192k") {
  return [
    `ffmpeg -hide_banner -loglevel error`,
    `-i "${input}"`,          // accurate seek: -ss AFTER -i
    `-ss ${startTS}`,
    `-t ${durTS}`,
    `-c:v libx264 -preset ${preset} -crf ${crf}`,
    `-c:a aac -b:a ${audioBitrate}`,
    `-movflags +faststart -fflags +genpts -avoid_negative_ts make_zero`,
    `-y "${outPath}"`
  ].join(" ");
}





function parseTimeInputs(q) {
  // Preferred: startMs/endMs numeric (milliseconds)
  if (q.startMs != null && q.endMs != null) {
    const startMs = Number(q.startMs);
    const endMs   = Number(q.endMs);
    if (!Number.isFinite(startMs) || !Number.isFinite(endMs)) {
      throw new Error("Invalid millisecond values.");
    }
    return { startMs, endMs };
  }

  // Fallback: numeric seconds
  const isNum = (v) => v != null && /^\d+(\.\d+)?$/.test(String(v));
  if (isNum(q.start) && isNum(q.end)) {
    const startMs = Math.round(parseFloat(q.start) * 1000);
    const endMs   = Math.round(parseFloat(q.end) * 1000);
    return { startMs, endMs };
  }

  // Fallback: HH:MM:SS.mmm
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
    const localPath = cachePathFor(fileId, name);


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
// ✅ NEW: Trim video route (supports preview without full download)
// -------------------------
app.post("/trim", async (req, res) => {
  const { fileId, preview } = req.body;
  if (!fileId) return res.status(400).send("Missing parameters.");

  try {
    const { name } = await getFileMetadata(fileId);
    const srcPath = cachePathFor(fileId, name);


    const inputUrl = `https://www.googleapis.com/drive/v3/files/${fileId}?alt=media&key=${API_KEY}`;
    let inputForFfmpeg = fs.existsSync(srcPath) ? srcPath : inputUrl;
    // then use inputForFfmpeg in both ffmpeg commands


    if (!fs.existsSync(srcPath)) {
      if (preview) {
        console.log("Using HTTP input for preview (no full download)…"); // ← added
        inputForFfmpeg = inputUrl; // ← added
      } else {
        console.log("Downloading source file for trimming...");
        await downloadFile(fileId, srcPath);
      }
    }

    // Parse time (supports startMs/endMs, numeric seconds, or HH:MM:SS.mmm)
    const { startMs, endMs } = parseTimeInputs(req.body);
    if (!(endMs > startMs)) throw new Error("End must be after start.");

    const startTS = msToTimestamp(startMs);
    const durTS   = msToTimestamp(endMs - startMs);


    const outPath = path.join(os.tmpdir(), `trimmed_${Date.now()}.mp4`);

    // Accurate preview (millisecond-precise): -ss AFTER -i + re-encode video
    const cmd = [
      'ffmpeg -hide_banner -loglevel error',
      `-i "${fs.existsSync(srcPath) ? srcPath : inputUrl}"`, // input first!
      `-ss ${startTS}`,
      `-t ${durTS}`,
      `-c:v libx264 -preset ultrafast -crf 20`,
      `-c:a aac -b:a 160k`,
      `-movflags +faststart`,
      `-y "${outPath}"`
    ].join(' ');
    console.log('Running:', cmd);
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



// ✅ Also support GET version for direct downloads
app.get("/trim", async (req, res) => {
  const { fileId } = req.query;
  if (!fileId) return res.status(400).send("Missing parameters.");

  try {
    const { name } = await getFileMetadata(fileId);
    const srcPath = cachePathFor(fileId, name);


    if (!fs.existsSync(srcPath)) {
      console.log("Downloading file for trim...");
      await downloadFile(fileId, srcPath);
    }

    const { startMs, endMs } = parseTimeInputs(req.query);
    if (!(endMs > startMs)) throw new Error("End must be after start.");

    const startTS = msToTimestamp(startMs);
    const durTS   = msToTimestamp(endMs - startMs);

    const outPath = path.join(os.tmpdir(), `trimmed_${Date.now()}.mp4`);

    // Download should be accurate and higher quality -> veryfast/CRF 18
    const cmd = ffmpegAccurateCmd(srcPath, startTS, durTS, outPath, "veryfast", 18, "192k");
    console.log("Running:", cmd);
    await execPromise(cmd);



    res.download(outPath, "trimmed_video.mp4", () => fs.unlink(outPath, () => {}));
  } catch (err) {
    console.error(err);
    res.status(500).send("❌ Failed to trim video: " + err.message);
  }
});


app.listen(PORT, () => console.log(`✅ Server running at http://localhost:${PORT}`));
