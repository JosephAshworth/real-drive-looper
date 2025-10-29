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
// Helper: normalize times (supports seconds or milliseconds)
// -------------------------
function normalizeTimes({ start, end, startMs, endMs }) {
  const s =
    start !== undefined
      ? parseFloat(start)
      : startMs !== undefined
      ? parseFloat(startMs) / 1000
      : NaN;

  const e =
    end !== undefined
      ? parseFloat(end)
      : endMs !== undefined
      ? parseFloat(endMs) / 1000
      : NaN;

  if (!Number.isFinite(s) || !Number.isFinite(e)) {
    throw new Error("Invalid start/end time.");
  }
  if (e <= s) throw new Error("End time must be after start time.");

  const startSec = +s.toFixed(3);
  const endSec = +e.toFixed(3);
  const duration = +(endSec - startSec).toFixed(3);

  // Force precise re-encode whenever ms are used
  const forcePrecise = startMs !== undefined || endMs !== undefined;
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

  try {
    const { name } = await getFileMetadata(fileId);
    const srcPath = path.join(os.tmpdir(), name);

    // Download if not already cached
    if (!fs.existsSync(srcPath)) {
      console.log("Downloading source file for trimming...");
      await downloadFile(fileId, srcPath);
    }

    const { startSec, duration, forcePrecise } = normalizeTimes({ start, end, startMs, endMs });

    const precise = forcePrecise || mode === "precise"; // auto-precise if ms given
    const outPath = path.join(os.tmpdir(), `trimmed_${Date.now()}.mp4`);

    const cmd = precise
      // Accurate seek (ms/frame precise): -ss AFTER -i + -t, with re-encode
      ? `ffmpeg -i "${srcPath}" -ss ${startSec} -t ${duration} -map 0 -c:v libx264 -preset veryfast -crf 20 -c:a aac -b:a 192k -movflags +faststart -pix_fmt yuv420p -y "${outPath}"`
      // Fast (keyframe-limited) copy
      : `ffmpeg -ss ${startSec} -t ${duration} -i "${srcPath}" -map 0 -c copy -movflags +faststart -y "${outPath}"`;

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


// ✅ GET version (supports ms via startMs/endMs)
app.get("/trim", async (req, res) => {
  const { fileId, start, end, startMs, endMs, mode } = req.query; // mode optional
  if (!fileId) return res.status(400).send("Missing fileId.");

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

    const cmd = precise
      ? `ffmpeg -i "${srcPath}" -ss ${startSec} -t ${duration} -map 0 -c:v libx264 -preset veryfast -crf 20 -c:a aac -b:a 192k -movflags +faststart -pix_fmt yuv420p -y "${outPath}"`
      : `ffmpeg -ss ${startSec} -t ${duration} -i "${srcPath}" -map 0 -c copy -movflags +faststart -y "${outPath}"`;

    console.log("Running:", cmd);
    await execPromise(cmd);

    res.download(outPath, "trimmed_video.mp4", () => fs.unlink(outPath, () => {}));
  } catch (err) {
    console.error(err);
    res.status(500).send("❌ Failed to trim video: " + err.message);
  }
});


app.listen(PORT, () => console.log(`✅ Server running at http://localhost:${PORT}`));
