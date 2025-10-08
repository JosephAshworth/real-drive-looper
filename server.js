import express from "express";
import fetch from "node-fetch";
import dotenv from "dotenv";
import fs from "fs";
import path from "path";
import os from "node:os";

dotenv.config();
const app = express();
const PORT = process.env.PORT || 3000;
const API_KEY = process.env.GOOGLE_API_KEY;

if (!API_KEY) {
  console.error("❌ Missing GOOGLE_API_KEY in .env file");
  process.exit(1);
}

app.use(express.static("public"));

// Track last downloaded temp file
let lastTempFile = null;

// -------------------------
// Automatic cleanup of old temp videos
// -------------------------
function cleanupTempFiles() {
  const tmpDir = os.tmpdir();
  const videoExts = [".mp4", ".mov", ".avi", ".mkv", ".webm"]; // add more if needed
  let videosFound = false;

  fs.readdir(tmpDir, (err, files) => {
    if (err) return console.error("Error reading temp directory:", err);

    files.forEach(file => {
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

    if (!videosFound) {
      console.log("No temp videos found to delete.");
    } else {
      console.log("Temp video cleanup complete.");
    }
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
// Download large file to temp directory
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
  

app.listen(PORT, () => console.log(`✅ Server running at http://localhost:${PORT}`));
