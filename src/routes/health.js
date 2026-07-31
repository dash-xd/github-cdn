"use strict";

const { NewEmptyRouter } = require("simple-router-builder");

const router = NewEmptyRouter();

router.get("/", (req, res) => {
    res.json({ status: "ok" });
});

module.exports = router;
