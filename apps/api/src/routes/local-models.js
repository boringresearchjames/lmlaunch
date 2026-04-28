import express from "express";
import fs from "fs";
import path from "path";
import os from "os";
import { modelsDir } from "../lib/config.js";

const router = express.Router();

router.get("/local-models", (_req, res) => {
  const home = os.homedir();
  const primaryDir = path.resolve(modelsDir.replace(/^~/, home));

  const extraDirs = [
    { dir: path.join(home, ".ollama", "models"), tag: "ollama" },
    { dir: "/usr/share/ollama/.ollama/models", tag: "ollama" },
    { dir: path.join(home, ".cache", "huggingface", "hub"), tag: "huggingface" },
    { dir: path.join(home, "unsloth_studio"), tag: "unsloth" },
  ];

  const seen = new Set();
  const results = [];
  const dirsScanned = [];

  function walk(dir, baseDir, tagPrefix) {
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(fullPath, baseDir, tagPrefix);
      } else if (entry.isFile() && entry.name.toLowerCase().endsWith(".gguf")) {
        if (seen.has(fullPath)) continue;
        seen.add(fullPath);
        const lower = entry.name.toLowerCase();
        const shardMatch = lower.match(/-(\d{5})-of-(\d{5})\.gguf$/);
        if (shardMatch && shardMatch[1] !== "00001") continue;
        const rel = path.relative(baseDir, fullPath);
        const name = tagPrefix ? `[${tagPrefix}] ${rel}` : rel;
        const shards = shardMatch ? parseInt(shardMatch[2], 10) : null;
        let size = null;
        try {
          if (shards) {
            let total = 0;
            for (let i = 1; i <= shards; i++) {
              const shardPath = fullPath.replace(/-\d{5}-of-/i, `-${String(i).padStart(5, "0")}-of-`);
              try { total += fs.statSync(shardPath).size; } catch { /* skip missing shard */ }
            }
            size = total || null;
          } else {
            size = fs.statSync(fullPath).size;
          }
        } catch { /* ignore */ }
        results.push({ id: fullPath, name, shards, size });
      }
    }
  }

  if (fs.existsSync(primaryDir)) {
    dirsScanned.push(primaryDir);
    walk(primaryDir, primaryDir, null);
  }

  for (const { dir, tag } of extraDirs) {
    if (dir === primaryDir || !fs.existsSync(dir)) continue;
    dirsScanned.push(dir);
    walk(dir, dir, tag);
  }

  if (results.length === 0 && dirsScanned.length === 0) {
    return res.json({ data: [], warning: `Models directory not found: ${primaryDir}` });
  }

  results.sort((a, b) => a.name.localeCompare(b.name));
  return res.json({ data: results, dir: primaryDir, dirs: dirsScanned });
});

export default router;
