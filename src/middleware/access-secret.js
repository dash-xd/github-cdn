"use strict";

const crypto = require("node:crypto");

function safeEqual(a, b) {
    const bufA = Buffer.from(a);
    const bufB = Buffer.from(b);

    if (bufA.length !== bufB.length) {
        return false;
    }

    return crypto.timingSafeEqual(bufA, bufB);
}

// The /app router authenticates to GitHub as the installation, not as
// whoever calls it, so unlike /github there's no caller-supplied GitHub
// token to double as authorization. This is the substitute: callers must
// present a server-configured shared secret as a bearer token.
function requireAccessSecret(getSecret) {
    return function requireAccessSecretMiddleware(req, res, next) {
        const expected = getSecret();

        if (!expected) {
            return res.status(500).json({ error: "server missing required access secret configuration" });
        }

        const header = req.headers.authorization || "";
        const provided = header.startsWith("Bearer ") ? header.slice(7).trim() : "";

        if (!provided || !safeEqual(provided, expected)) {
            return res.status(401).json({ error: "missing or invalid access secret" });
        }

        next();
    };
}

module.exports = { requireAccessSecret };
