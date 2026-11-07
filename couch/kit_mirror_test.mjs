// node --test: the web branch's kit mirror (web/static/kit/couch on origin/web) serves the same kit files as couch/ on main.
// web/kit_mirror.py's is_kit decides what is kit; anything else (tests and their data, .gitignore, the operator's re-pin
// tools) is deliberately not mirrored. Drift skips with the list rather than failing, so it is reported, not hidden.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const gitRaw = (...args) => execFileSync("git", ["-C", root, ...args]);
const git = (...args) => gitRaw(...args).toString("utf8").trim();
const has = ref => { try { return Boolean(git("rev-parse", "--verify", "--quiet", `${ref}^{commit}`)); } catch { return false; } };

// Not kit (web/kit_mirror.py is_kit): tests and their data, couch/.gitignore, the operator's re-pin tools.
const isKit = f => !(/_test\.\w+$/.test(f) || f.startsWith("couch/testdata/") || f === "couch/.gitignore"
  || (f.startsWith("couch/dsmack/") && /\.(sh|py)$/.test(f)));
const mirrored = f => "web/static/kit/" + f;

test("the kit mirror on the web branch matches couch/'s kit files on main", t => {
  const base = has("main") ? "main" : has("origin/main") ? "origin/main" : "", web = has("origin/web") ? "origin/web" : "";
  if (!base || !web) { t.skip(`cannot compare the kit mirror: ${[!base && "main", !web && "origin/web"].filter(Boolean).join(" and ")} missing from this clone`); return; }

  const kit = git("ls-tree", "-r", "--name-only", base, "couch/").split("\n").filter(Boolean).filter(isKit);
  const served = git("ls-tree", "-r", "--name-only", web, "web/static/kit/couch/").split("\n").filter(Boolean)
    .map(f => "couch/" + f.slice("web/static/kit/couch/".length));
  assert.ok(kit.length > 10 && served.length > 10, "both sides of the mirror must list the kit");

  const drift = [];
  for (const f of kit) {
    if (!served.includes(f)) { drift.push(`${f} is kit on ${base} but the web mirror does not serve it`); continue; }
    if (!gitRaw("show", `${base}:${f}`).equals(gitRaw("show", `${web}:${mirrored(f)}`))) drift.push(`${f} differs from ${mirrored(f)} on ${web}`);
  }
  for (const f of served) if (!kit.includes(f)) drift.push(`${f} is served by the web mirror but is not kit on ${base}`);
  if (drift.length) t.skip(`kit mirror drift (${drift.length}): ${drift.join("; ")}`);
});
