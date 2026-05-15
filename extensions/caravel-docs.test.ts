/**
 * Caravel documentation and gitignore tests.
 *
 * Verifies:
 * - README.md contains all required feature sections (4 subsections)
 * - .gitignore contains all required Caravel state file entries
 *
 * Run: npx vitest run extensions/caravel-docs.test.ts
 */

import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "vitest";

// ── helpers ────────────────────────────────────────────────────────────────

function readProjectFile(name: string): string {
  const p = join(__dirname, "..", name);
  return readFileSync(p, "utf-8");
}

/**
 * Counts top-level markdown headings (## ) in a string.
 */
function countHeadings(text: string, marker: string): number {
  const lines = text.split("\n");
  return lines.filter((l) => l.startsWith(marker)).length;
}

/**
 * Extracts the content between two markers from a string.
 */
function extractBetween(text: string, startMarker: string, endMarker: string): string {
  const start = text.indexOf(startMarker);
  if (start === -1) return "";
  const afterStart = text.slice(start + startMarker.length);
  const end = afterStart.indexOf(endMarker);
  return end === -1 ? afterStart : afterStart.slice(0, end);
}

// ── README.md feature sections ─────────────────────────────────────────────

describe("README.md feature sections", () => {
  const readme = readProjectFile("README.md");

  it("exists and is non-empty", () => {
    assert.ok(readme.length > 0, "README.md should not be empty");
  });

  it('has a "## Features" section', () => {
    assert.ok(
      readme.indexOf("## Features") !== -1,
      'README must have a "## Features" section',
    );
  });

  it("has exactly 4 feature subsections under ## Features", () => {
    const featureIdx = readme.indexOf("## Features");
    const afterFeatures = readme.slice(featureIdx);
    const nextTopLevel = afterFeatures.indexOf("\n## ", 1);
    const featureBlock =
      nextTopLevel === -1 ? afterFeatures : afterFeatures.slice(0, nextTopLevel);
    const sectionCount = countHeadings(featureBlock, "### ");
    assert.strictEqual(
      sectionCount,
      4,
      `## Features must contain exactly 4 subsections, found ${sectionCount}`,
    );
  });

  it('has "### Configuration Examples" section', () => {
    assert.ok(
      readme.includes("### Configuration Examples"),
      'README must contain "### Configuration Examples" heading',
    );
  });

  it("Configuration Examples contains concrete config scenarios", () => {
    const configExamples = extractBetween(
      readme,
      "### Configuration Examples",
      "### Activation",
    );
    assert.ok(
      configExamples.includes("models.json"),
      "Configuration Examples should reference models.json",
    );
    assert.ok(
      configExamples.includes("```json"),
      "Configuration Examples should include JSON code blocks",
    );
    assert.ok(
      configExamples.includes("llama.cpp") ||
        configExamples.includes("ollama") ||
        configExamples.includes("openai"),
      "Configuration Examples should show at least one provider example",
    );
  });

  it('has "### Activation" section', () => {
    assert.ok(
      readme.includes("### Activation"),
      'README must contain "### Activation" heading',
    );
  });

  it("Activation section covers both Pi Mode and ZFS Mode", () => {
    const activation = extractBetween(
      readme,
      "### Activation",
      "### Monitoring & Control",
    );
    assert.ok(
      activation.includes("Pi Mode"),
      "Activation should reference Pi Mode",
    );
    assert.ok(
      activation.includes("ZFS") || activation.includes("zellij"),
      "Activation should reference ZFS mode",
    );
  });

  it('has "### Monitoring & Control" section', () => {
    assert.ok(
      readme.includes("### Monitoring & Control"),
      'README must contain "### Monitoring & Control" heading',
    );
  });

  it('has "### Troubleshooting" section', () => {
    assert.ok(
      readme.includes("### Troubleshooting"),
      'README must contain "### Troubleshooting" heading',
    );
  });

  it("Troubleshooting section contains actionable fixes", () => {
    const troubleshooting = extractBetween(
      readme,
      "### Troubleshooting",
      "\n## ",
    );
    assert.ok(
      troubleshooting.includes("Error:"),
      "Troubleshooting should include error examples",
    );
    assert.ok(
      troubleshooting.includes("→"),
      "Troubleshooting should include fix directives",
    );
  });
});

// ── .gitignore Caravel entries ─────────────────────────────────────────────

describe(".gitignore Caravel entries", () => {
  const gitignore = readProjectFile(".gitignore");

  it("exists and is non-empty", () => {
    assert.ok(gitignore.length > 0, ".gitignore should not be empty");
  });

  const requiredEntries = [
    ".caravel/agents.json",
    ".caravel/health.json",
    ".caravel/messages.json",
    ".caravel/seances.json",
  ];

  for (const entry of requiredEntries) {
    it(`contains "${entry}"`, () => {
      const lines = gitignore.split("\n");
      const found = lines.some((l) => l.trim() === entry);
      assert.ok(
        found,
        `.gitignore must contain exact line: "${entry}"`,
      );
    });
  }

  it("also has the .caravel/ directory entry", () => {
    const lines = gitignore.split("\n");
    const found = lines.some((l) => l.trim() === ".caravel/");
    assert.ok(
      found,
      ".gitignore should contain the .caravel/ directory entry",
    );
  });
});
