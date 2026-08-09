"use strict";

const crypto = require("node:crypto");
const { OAuth2Client } = require("google-auth-library");

const oauthClient = new OAuth2Client();

function safeEqual(a, b) {
    const bufA = Buffer.from(a);
    const bufB = Buffer.from(b);

    if (bufA.length !== bufB.length) {
        return false;
    }

    return crypto.timingSafeEqual(bufA, bufB);
}

// Verifies the bearer token is a Google-signed OIDC identity token for one
// of the trusted service account emails, audienced to this deployment.
// This is what a Workload Identity Federation-authenticated caller (e.g.
// a GitHub Actions job using google-github-actions/auth) presents: WIF
// already proved the workflow's identity to GCP, and the same auth step
// can mint an identity token for that service account with
// `id_token_audience` set to this function's URL. Verified here against
// Google's own public keys - nothing this service holds has to be
// provisioned or rotated for a caller using this strategy.
async function verifyGcpIdentity(token, trustedEmails, audience) {
    if (trustedEmails.length === 0 || !audience) {
        return false;
    }

    try {
        const ticket = await oauthClient.verifyIdToken({ idToken: token, audience });
        const payload = ticket.getPayload();
        return Boolean(payload && payload.email_verified && trustedEmails.includes(payload.email));
    } catch {
        return false;
    }
}

// The /app router authenticates to GitHub as the installation, not as
// whoever calls it, so unlike /github there's no caller-supplied GitHub
// token to double as authorization for the *call itself*. This is the
// substitute - and it's deliberately more than one fixed mechanism, since
// different deployments have different callers:
//
//  - A trusted GCP identity (getTrustedEmails/getAudience): for callers
//    that already prove who they are to GCP some other way (WIF being
//    the common case) and would rather not provision a separate secret
//    for this service on top of that.
//  - A static shared secret (getSecret): for callers with no GCP identity
//    of their own to present - simpler to set up, at the cost of being
//    one more secret to generate, store, and rotate.
//
// Either succeeding authorizes the request. A deployment can configure
// one, both, or (leaving both unset) none - in which case /app is
// unreachable by design (500) rather than silently open.
function requireAppAccess({ getSecret, getTrustedEmails, getAudience }) {
    return async function requireAppAccessMiddleware(req, res, next) {
        const secret = getSecret();
        const trustedEmails = getTrustedEmails ? getTrustedEmails() : [];
        const audience = getAudience ? getAudience() : null;

        if (!secret && trustedEmails.length === 0) {
            return res.status(500).json({
                error: "server missing /app authorization configuration: set APP_ACCESS_SECRET and/or TRUSTED_GCP_INVOKER_EMAILS"
            });
        }

        const header = req.headers.authorization || "";
        const provided = header.startsWith("Bearer ") ? header.slice(7).trim() : "";

        if (!provided) {
            return res.status(401).json({ error: "missing Authorization: Bearer <token> header" });
        }

        if (secret && safeEqual(provided, secret)) {
            return next();
        }

        if (await verifyGcpIdentity(provided, trustedEmails, audience)) {
            return next();
        }

        res.status(401).json({ error: "unauthorized" });
    };
}

module.exports = { requireAppAccess };
