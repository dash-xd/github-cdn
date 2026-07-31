"use strict";

const Busboy = require("busboy");

// GitHub's blob creation API caps content around 100MB, but keep uploads
// modest since blobs are base64-encoded and buffered in memory here.
const MAX_FILE_BYTES = 25 * 1024 * 1024;

// Filenames become git blob paths, so nested paths (e.g. "src/index.js")
// must survive busboy's default basename-only behavior, and anything that
// could escape the repo tree (leading "/", "..", drive letters) is rejected.
function isSafeRelativePath(filePath) {
    if (!filePath) return false;
    const normalized = filePath.replace(/\\/g, "/");
    if (normalized.startsWith("/") || /^[a-zA-Z]:/.test(normalized)) return false;
    const segments = normalized.split("/");
    return segments.every((segment) => segment !== "" && segment !== "." && segment !== "..");
}

function parseUpload(req, res, next) {
    const contentType = req.headers["content-type"] || "";

    if (!contentType.startsWith("multipart/form-data")) {
        return res.status(400).json({ error: "expected multipart/form-data" });
    }

    let busboy;
    try {
        busboy = Busboy({ headers: req.headers, limits: { fileSize: MAX_FILE_BYTES }, preservePath: true });
    } catch (err) {
        return res.status(400).json({ error: "invalid multipart payload" });
    }

    const files = [];
    const fields = {};
    let failed = false;

    busboy.on("field", (name, value) => {
        fields[name] = value;
    });

    busboy.on("file", (fieldName, stream, info) => {
        const chunks = [];

        if (!isSafeRelativePath(info.filename)) {
            failed = true;
            res.status(400).json({ error: `invalid file path: ${info.filename}` });
            stream.resume();
            req.unpipe(busboy);
            return;
        }

        stream.on("data", (chunk) => chunks.push(chunk));

        stream.on("limit", () => {
            failed = true;
            res.status(413).json({ error: `file exceeds ${MAX_FILE_BYTES} bytes: ${info.filename}` });
            req.unpipe(busboy);
        });

        stream.on("end", () => {
            if (!failed) {
                files.push({
                    path: info.filename,
                    content: Buffer.concat(chunks)
                });
            }
        });
    });

    busboy.on("error", (err) => {
        failed = true;
        next(err);
    });

    busboy.on("finish", () => {
        if (failed) return;

        if (files.length === 0) {
            return res.status(400).json({ error: "no files uploaded" });
        }

        req.files = files;
        req.body = { ...req.body, ...fields };
        next();
    });

    req.pipe(busboy);
}

module.exports = { parseUpload };
