"use strict";

const { SimpleRouterBuilder } = require("simple-router-builder");

const githubRouter = require("./src/routes/github-repos.js");
const healthRouter = require("./src/routes/health.js");

exports.Main = new SimpleRouterBuilder()
    .withChildRouter("/github", githubRouter)
    .withChildRouter("/healthz", healthRouter)
    .withRootHandler((req, res) => {
        res.statusCode = 404;
        res.end("Not found");
    })
    .build();
