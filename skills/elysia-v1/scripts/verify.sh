#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
SKILL_DIR="$(cd -- "$SCRIPT_DIR/.." && pwd)"
REPO_ROOT="$(cd -- "$SKILL_DIR/../.." && pwd)"

(cd "$REPO_ROOT" && bun run typecheck)
bun test "$SKILL_DIR/examples/relaybox/tests"

if command -v markdownlint >/dev/null 2>&1; then
  markdownlint --config "$SKILL_DIR/.markdownlint.json" \
    "$SKILL_DIR/SKILL.md" \
    "$SKILL_DIR"/references/*.md
fi

bun -e '
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const skillDir = process.argv[1];
const files = [
  join(skillDir, "SKILL.md"),
  ...readdirSync(join(skillDir, "references"))
    .filter((f) => f.endsWith(".md"))
    .sort()
    .map((f) => join(skillDir, "references", f)),
];

const bad = [];
for (const file of files) {
  const text = readFileSync(file, "utf8");
  const lines = text.split("\n");
  lines.forEach((line, idx) => {
    if (/[\u2013\u2014]/.test(line)) {
      bad.push(`${file}:${idx + 1}: ${line}`);
    }
  });
}

if (bad.length > 0) {
  console.error("Found forbidden emdash/endash characters:\n" + bad.join("\n"));
  process.exit(1);
}
' "$SKILL_DIR"
