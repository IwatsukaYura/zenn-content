#!/usr/bin/env node
/**
 * Publish or update a Markdown file on Dev.to via API.
 * Published article IDs are stored in medium/.article-ids.json to enable updates.
 *
 * Usage:
 *   DEVTO_TOKEN=your_token node medium/publish-devto.mjs medium/your-article.md
 *
 * Or store the token in .env:
 *   echo "DEVTO_TOKEN=your_token" >> .env
 *   node medium/publish-devto.mjs medium/your-article.md
 *
 * Get your token at: https://dev.to/settings/extensions > DEV Community API Keys
 *
 * Frontmatter fields:
 *   title       : string (required)
 *   tags        : ["tag1", "tag2"]  max 4 tags
 *   published   : true | false      (default: false = draft)
 *   canonicalUrl: ""                (optional, set to Zenn article URL for SEO)
 */

import fs from "fs";
import path from "path";

// Load .env if present
const envPath = path.resolve(".env");
if (fs.existsSync(envPath)) {
  for (const line of fs.readFileSync(envPath, "utf-8").split("\n")) {
    const [key, ...rest] = line.split("=");
    if (key && rest.length) process.env[key.trim()] = rest.join("=").trim();
  }
}

const token = process.env.DEVTO_TOKEN;
if (!token) {
  console.error("Error: DEVTO_TOKEN is not set.");
  console.error("  export DEVTO_TOKEN=your_token  or add it to .env");
  process.exit(1);
}

const filePath = process.argv[2];
if (!filePath) {
  console.error("Usage: node medium/publish-devto.mjs <path-to-markdown>");
  process.exit(1);
}

const raw = fs.readFileSync(path.resolve(filePath), "utf-8");

// Parse frontmatter
const fmMatch = raw.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
if (!fmMatch) {
  console.error("Error: frontmatter not found. Add --- block at the top of the file.");
  process.exit(1);
}

const fmRaw = fmMatch[1];
const body_markdown = fmMatch[2].trim();

function parseFrontmatter(text) {
  const result = {};
  for (const line of text.split("\n")) {
    const colonIdx = line.indexOf(":");
    if (colonIdx === -1) continue;
    const key = line.slice(0, colonIdx).trim();
    let value = line.slice(colonIdx + 1).trim().replace(/^"|"$/g, "");

    if (value.startsWith("[")) {
      value = value
        .replace(/^\[|\]$/g, "")
        .split(",")
        .map((v) => v.trim().replace(/^"|"$/g, ""))
        .filter(Boolean);
    }
    if (value === "true") value = true;
    if (value === "false") value = false;

    result[key] = value;
  }
  return result;
}

const fm = parseFrontmatter(fmRaw);

if (!fm.title) {
  console.error("Error: 'title' is required in frontmatter.");
  process.exit(1);
}

if (!fm.published) {
  console.log(`Skipped (published: false): ${filePath}`);
  process.exit(0);
}

// Load article ID store
const idsPath = path.resolve("medium/.article-ids.json");
const idStore = fs.existsSync(idsPath) ? JSON.parse(fs.readFileSync(idsPath, "utf-8")) : {};
const existingId = idStore[filePath];

const tags = Array.isArray(fm.tags) ? fm.tags.slice(0, 4) : [];

const article = {
  title: fm.title,
  body_markdown,
  published: true,
  tags,
};
if (fm.canonicalUrl) article.canonical_url = fm.canonicalUrl;

console.log(`Title    : ${article.title}`);
console.log(`Tags     : ${tags.join(", ")}`);
console.log(`Action   : ${existingId ? `update (id: ${existingId})` : "create"}`);
console.log("");

const url = existingId
  ? `https://dev.to/api/articles/${existingId}`
  : "https://dev.to/api/articles";
const method = existingId ? "PUT" : "POST";

const res = await fetch(url, {
  method,
  headers: {
    "api-key": token,
    "Content-Type": "application/json",
  },
  body: JSON.stringify({ article }),
});

if (!res.ok) {
  console.error(`Failed to ${existingId ? "update" : "publish"}: ${res.status}`);
  console.error(await res.text());
  process.exit(1);
}

const post = await res.json();

// Save article ID for future updates
idStore[filePath] = post.id;
fs.writeFileSync(idsPath, JSON.stringify(idStore, null, 2) + "\n", "utf-8");

console.log(`${existingId ? "Updated" : "Published"} successfully!`);
console.log(`URL : ${post.url}`);
console.log(`ID  : ${post.id} (saved to medium/.article-ids.json)`);
