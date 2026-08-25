"use strict";

const crypto = require("node:crypto");
const Busboy = require("busboy");

// GitHub blob creation API caps content around 100MB, but keep uploads
// modest since blobs are base64-encoded and buffered in memory here.
const MAX_FILE_BYTES = 25 * 1024 * 1024;

function objectPath(hash) {
    return `objects/${hash.slice(0, 2)}/${hash}`;
}

function parseUpload(req, res, next) {
    const contentType = req.headers["content-type"] || "";

    if (!contentType.startsWith("multipart/form-data")) {
        return res.status(400).json({
            error: "expected multipart/form-data"
        });
    }

    let busboy;

    try {
        busboy = Busboy({
            headers: req.headers,
            limits: {
                fileSize: MAX_FILE_BYTES
            }
        });
    } catch (err) {
        return res.status(400).json({
            error: "invalid multipart payload"
        });
    }

    const files = [];
    const fields = {};
    let failed = false;

    busboy.on("field", (name, value) => {
        fields[name] = value;
    });

    busboy.on("file", (fieldName, stream, info) => {
        const chunks = [];

        stream.on("data", (chunk) => {
            chunks.push(chunk);
        });

        stream.on("limit", () => {
            failed = true;

            res.status(413).json({
                error: `file exceeds ${MAX_FILE_BYTES} bytes`
            });

            req.unpipe(busboy);
        });

        stream.on("end", () => {
            if (failed) {
                return;
            }

            const content = Buffer.concat(chunks);

            const objectId = crypto
                .createHash("sha256")
                .update(content)
                .digest("hex");

            files.push({
                objectId,
                path: objectPath(objectId),
                originalName: info.filename,
                contentType: info.mimeType,
                size: content.length,
                content
            });
        });
    });

    busboy.on("error", (err) => {
        failed = true;
        next(err);
    });

    busboy.on("finish", () => {
        if (failed) {
            return;
        }

        if (files.length === 0) {
            return res.status(400).json({
                error: "no files uploaded"
            });
        }

        res.locals.files = files;

        req.body = {
            ...req.body,
            ...fields
        };

        next();
    });

    // The Google Functions Framework buffers request bodies before invoking
    // the function and exposes the original bytes as req.rawBody. In that
    // environment req is already drained, so piping it into Busboy produces
    // "Unexpected end of form". Keep the stream fallback for plain Node/Express.
    if (Buffer.isBuffer(req.rawBody)) {
        busboy.end(req.rawBody);
    } else {
        req.pipe(busboy);
    }
}

module.exports = {
    parseUpload,
    objectPath
};
