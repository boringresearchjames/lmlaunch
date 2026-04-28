import express from "express";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { now } from "../lib/utils.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootPkg = JSON.parse(fs.readFileSync(path.resolve(__dirname, "../../../../package.json"), "utf8"));

const router = express.Router();

router.get("/health", (_req, res) => {
  res.json({
    status: "ok",
    service: "api",
    version: rootPkg.version || "unknown",
    node: process.version,
    at: now(),
  });
});

export default router;
