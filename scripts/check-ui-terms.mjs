#!/usr/bin/env node
/**
 * 화면에 노출되는 문자열에서 쓰지 않기로 한 말을 찾는다 (기획 D1·D7).
 *
 *   node scripts/check-ui-terms.mjs
 *
 * 용어 지적은 세 프로젝트 모두에서 한 번 고친 뒤 다시 되살아났다. 사람이 매번 훑는 대신
 * 이 검사를 릴리스 전에 돌린다. 코드 식별자는 대상이 아니고, 사람에게 보이는 한국어
 * 문자열과 JSX 텍스트만 본다.
 *
 * 종료 코드: 위반이 있으면 1.
 */

import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, extname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(fileURLToPath(new URL(".", import.meta.url)), "..");
const SRC = join(ROOT, "src");

/** 검사에서 빼는 경로 — 사전 자신, 자동 생성물, 외부에서 가져온 UI 부품. */
const SKIP = [
  join("src", "lib", "glossary.ts"),
  join("src", "components", "ui"),
  join("src", "routeTree.gen.ts"),
  join("src", "integrations", "supabase", "types.ts"),
];

const { BANNED_TERMS } = await import("../src/lib/glossary.ts").catch(async () => {
  // ts 를 직접 못 읽는 환경에서는 파일에서 표를 뽑아 쓴다.
  const text = readFileSync(join(SRC, "lib", "glossary.ts"), "utf8");
  const block = text.slice(
    text.indexOf("BANNED_TERMS"),
    text.indexOf("};", text.indexOf("BANNED_TERMS")),
  );
  const table = {};
  for (const m of block.matchAll(/["']?([^"'\s:]+)["']?\s*:\s*["']([^"']+)["']/g)) {
    table[m[1]] = m[2];
  }
  return { BANNED_TERMS: table };
});

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    const rel = relative(ROOT, full);
    if (SKIP.some((s) => rel === s || rel.startsWith(s + "\\") || rel.startsWith(s + "/"))) continue;
    if (statSync(full).isDirectory()) walk(full, out);
    else if ([".ts", ".tsx"].includes(extname(full))) out.push(full);
  }
  return out;
}

/** 주석 줄은 개발자용이므로 검사하지 않는다. */
function isComment(line) {
  const t = line.trim();
  return t.startsWith("//") || t.startsWith("*") || t.startsWith("/*");
}

/**
 * 한 줄에서 사람에게 보일 만한 조각만 뽑는다.
 * 한글이 든 문자열 리터럴과 JSX 텍스트만 대상이며, 코드 식별자는 애초에 걸리지 않는다.
 */
function visibleFragments(line) {
  const out = [];
  for (const m of line.matchAll(/"([^"\\]*)"|'([^'\\]*)'|`([^`\\]*)`/g)) {
    const s = m[1] ?? m[2] ?? m[3] ?? "";
    if (/[가-힣]/.test(s)) out.push(s);
  }
  for (const m of line.matchAll(/>([^<>{}]*[가-힣][^<>{}]*)</g)) out.push(m[1]);
  return out;
}

const findings = [];

for (const file of walk(SRC)) {
  const lines = readFileSync(file, "utf8").split(/\r?\n/);
  lines.forEach((line, i) => {
    if (isComment(line)) return;
    const fragments = visibleFragments(line);
    if (fragments.length === 0) return;
    for (const [banned, replacement] of Object.entries(BANNED_TERMS)) {
      if (!fragments.some((f) => f.includes(banned))) continue;
      findings.push({
        file: relative(ROOT, file),
        line: i + 1,
        banned,
        replacement,
        text: line.trim().slice(0, 110),
      });
    }
  });
}

if (findings.length === 0) {
  console.log("화면 문구 검사 통과 — 쓰지 않기로 한 말이 없습니다.");
  process.exit(0);
}

console.log(`화면 문구 위반 ${findings.length}건\n`);
for (const f of findings) {
  console.log(`${f.file}:${f.line}`);
  console.log(`  "${f.banned}" → "${f.replacement}"`);
  console.log(`  ${f.text}\n`);
}
process.exit(1);
