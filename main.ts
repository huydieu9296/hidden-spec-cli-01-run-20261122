// main.ts is mend, the CLI SPEC.md specifies. Node 22, standard library alone.

import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';

const FORMATS = ['auto', 'unified', 'search-replace', 'v4a', 'json'];

class Exit2 {
  readonly line: string;
  constructor(line: string) {
    this.line = line;
  }
}
class Fail {
  readonly code: string;
  readonly path: string;
  constructor(code: string, path: string) {
    this.code = code;
    this.path = path;
  }
}

const blank = (s: string): boolean => s.trim() === '';

function patchLines(text: string): string[] {
  if (text === '') return [];
  const lines = text.split('\n');
  if (text.endsWith('\n')) lines.pop();
  return lines.map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l));
}

function safe(p: string): boolean {
  return p !== '' && !p.startsWith('/') && !p.includes('\\') && p.split('/').every((s) => s !== '' && s !== '.' && s !== '..');
}

/** The tree as the edits leave it: changed paths in `now` (null: deleted), the rest read from disk. */
class Tree {
  private readonly orig = new Map<string, string | null>();
  readonly now = new Map<string, string | null>();
  original(p: string): string | null {
    if (!this.orig.has(p)) {
      let v: string | null = null;
      try {
        if (statSync(p).isFile()) v = readFileSync(p, 'utf8');
      } catch {
        v = null;
      }
      this.orig.set(p, v);
    }
    return this.orig.get(p)!;
  }
  get(p: string): string | null {
    return this.now.has(p) ? this.now.get(p)! : this.original(p);
  }
}

interface MovePair {
  oldPath: string;
  newPath: string;
}

type Edit = (tree: Tree, movePairs: MovePair[]) => void;

function detect(lines: string[]): string | null {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) return null;
  if (lines[first]!.trim() === '*** Begin Patch') return 'v4a';
  const c = lines[first]!.trimStart()[0];
  if (c === '[' || c === '{') return 'json';
  if (lines.some((l) => l.trimEnd() === '<<<<<<< SEARCH')) return 'search-replace';
  if (lines.some((l, i) => l.startsWith('diff --git ') || (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')))) return 'unified';
  return null;
}

// Helper functions for line matching & line breaks

function trimTrailing(s: string): string {
  return s.replace(/[ \t]+$/, '');
}

function trimBoth(s: string): string {
  return s.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');
}

function getLeadingIndent(s: string): string {
  const m = s.match(/^[ \t]*/);
  return m ? m[0]! : '';
}

interface FileContent {
  lines: string[];
  br: string;
  hasFinalBreak: boolean;
}

function parseFileText(text: string): FileContent {
  if (text === '') {
    return { lines: [], br: '\n', hasFinalBreak: false };
  }
  const nl = text.indexOf('\n');
  const br = nl > 0 && text[nl - 1] === '\r' ? '\r\n' : '\n';
  const hasFinalBreak = text.endsWith(br);
  let content = text;
  if (hasFinalBreak) {
    content = text.slice(0, -br.length);
  }
  const lines = content.split(br);
  return { lines, br, hasFinalBreak };
}

function stringifyFileText(fc: FileContent): string {
  if (fc.lines.length === 0) return '';
  return fc.lines.join(fc.br) + (fc.hasFinalBreak ? fc.br : '');
}

interface OccurrencesResult {
  tier: number; // 0, 1, or 2
  occurrences: number[]; // 0-based indices in F_lines
}

function findOccurrences(
  F_lines: string[],
  O: string[],
  strict: boolean,
  startFrom: number = 0
): OccurrencesResult | null {
  const k = O.length;
  if (k === 0) return { tier: 0, occurrences: [] };
  if (startFrom + k > F_lines.length) return null;

  // Tier 0
  const occ0: number[] = [];
  for (let i = startFrom; i <= F_lines.length - k; i++) {
    let match = true;
    for (let j = 0; j < k; j++) {
      if (F_lines[i + j] !== O[j]) {
        match = false;
        break;
      }
    }
    if (match) occ0.push(i);
  }
  if (occ0.length > 0) return { tier: 0, occurrences: occ0 };
  if (strict) return null;

  // Tier 1
  const occ1: number[] = [];
  const O_t1 = O.map(trimTrailing);
  for (let i = startFrom; i <= F_lines.length - k; i++) {
    let match = true;
    for (let j = 0; j < k; j++) {
      if (trimTrailing(F_lines[i + j]!) !== O_t1[j]) {
        match = false;
        break;
      }
    }
    if (match) occ1.push(i);
  }
  if (occ1.length > 0) return { tier: 1, occurrences: occ1 };

  // Tier 2
  const occ2: number[] = [];
  const O_t2 = O.map(trimBoth);
  for (let i = startFrom; i <= F_lines.length - k; i++) {
    let match = true;
    for (let j = 0; j < k; j++) {
      if (trimBoth(F_lines[i + j]!) !== O_t2[j]) {
        match = false;
        break;
      }
    }
    if (match) occ2.push(i);
  }
  if (occ2.length > 0) return { tier: 2, occurrences: occ2 };

  return null;
}

// First index at or after `from` whose line matches `anchor` exactly
// (tier 0), else ignoring trailing whitespace (tier 1), else ignoring
// leading and trailing whitespace (tier 2); -1 when there is no match.
// Tiers 1/2 are skipped in strict mode.
function findAnchorAtOrAfter(
  lines: string[],
  anchor: string,
  strict: boolean,
  from: number
): number {
  for (let idx = from; idx < lines.length; idx++) {
    if (lines[idx] === anchor) return idx;
  }
  if (strict) return -1;
  const t1Anchor = trimTrailing(anchor);
  for (let idx = from; idx < lines.length; idx++) {
    if (trimTrailing(lines[idx]!) === t1Anchor) return idx;
  }
  const t2Anchor = trimBoth(anchor);
  for (let idx = from; idx < lines.length; idx++) {
    if (trimBoth(lines[idx]!) === t2Anchor) return idx;
  }
  return -1;
}

function applyTier2Reindent(line: string, F_first: string, O_first: string): string {
  if (trimBoth(line) === '') return line;
  const P = getLeadingIndent(O_first);
  const F = getLeadingIndent(F_first);
  if (line.startsWith(P)) {
    return F + line.slice(P.length);
  }
  return line;
}

/** One JSON edit object (SPEC.md section 9), or null when it is not one. */
function jsonEdit(v: unknown): Edit | null {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  const p = o.path;
  if (typeof p !== 'string') return null;
  const exists = (tree: Tree): string => {
    if (!safe(p)) throw new Fail('unsafe', p);
    const t = tree.get(p);
    if (t === null) throw new Fail('missing', p);
    return t;
  };
  if (o.command === 'create' && typeof o.file_text === 'string') {
    const text = o.file_text;
    return (tree) => {
      if (!safe(p)) throw new Fail('unsafe', p);
      if (tree.get(p) !== null) throw new Fail('exists', p);
      tree.now.set(p, text);
    };
  }
  if (o.command === 'str_replace' && typeof o.old_str === 'string' && o.old_str !== '' && (o.new_str === undefined || typeof o.new_str === 'string')) {
    const oldStr = o.old_str;
    const newStr = (o.new_str as string | undefined) ?? '';
    return (tree) => {
      const before = exists(tree);
      const nl = before.indexOf('\n');
      const crlf = nl > 0 && before[nl - 1] === '\r';
      const lf = (s: string): string => (crlf ? s.replaceAll('\r\n', '\n') : s);
      const t = lf(before);
      const old = lf(oldStr);
      let count = 0;
      for (let k = t.indexOf(old); k >= 0; k = t.indexOf(old, k + 1)) count += 1;
      if (count === 0) throw new Fail('no-match', p);
      if (count > 1) throw new Fail('ambiguous', p);
      const at = t.indexOf(old);
      const out = t.slice(0, at) + lf(newStr) + t.slice(at + old.length);
      tree.now.set(p, crlf ? out.replaceAll('\n', '\r\n') : out);
    };
  }
  if (o.command === 'insert' && typeof o.insert_line === 'number' && Number.isInteger(o.insert_line) && typeof o.new_str === 'string') {
    const line = o.insert_line;
    const add = patchLines(o.new_str);
    return (tree) => {
      const before = exists(tree);
      const nl = before.indexOf('\n');
      const br = nl > 0 && before[nl - 1] === '\r' ? '\r\n' : '\n';
      const lines = before === '' ? [] : before.split(br);
      const final = before !== '' && before.endsWith(br);
      if (final) lines.pop();
      if (line < 0 || line > lines.length) throw new Fail('no-match', p);
      lines.splice(line, 0, ...add);
      tree.now.set(p, lines.length === 0 ? '' : lines.join(br) + (final ? br : ''));
    };
  }
  return null;
}

function jsonEdits(text: string, lines: string[]): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  const edits: Edit[] = [];
  if (lines[first]!.trimStart().startsWith('[')) {
    let v: unknown;
    try {
      v = JSON.parse(text);
    } catch {
      throw new Exit2(`error: parse ${first + 1}`);
    }
    if (!Array.isArray(v)) throw new Exit2(`error: parse ${first + 1}`);
    for (const x of v) {
      const e = jsonEdit(x);
      if (e === null) throw new Exit2(`error: parse ${first + 1}`);
      edits.push(e);
    }
    return edits;
  }
  lines.forEach((l, i) => {
    if (blank(l)) return;
    let e: Edit | null = null;
    try {
      e = jsonEdit(JSON.parse(l));
    } catch {
      e = null;
    }
    if (e === null) throw new Exit2(`error: parse ${i + 1}`);
    edits.push(e);
  });
  return edits;
}

// Unified Diffs (SPEC Section 6)

interface UnifiedHunkItem {
  type: ' ' | '-' | '+';
  line: string;
  O_index?: number; // for context lines, which line of O this is
}

interface UnifiedHunk {
  A: number;
  C: number;
  O: string[];
  N_items: UnifiedHunkItem[];
  hunkEndsNoNewline: boolean;
}

interface UnifiedSection {
  oldPath: string | null;
  newPath: string | null;
  isCreation: boolean;
  isDeletion: boolean;
  hunks: UnifiedHunk[];
}

function parseUnifiedPath(raw: string): string {
  let p = raw.split('\t')[0]!.trim();
  if (p === '/dev/null') return '/dev/null';
  p = p.replace(/^[ab]\//, '');
  return p;
}

function unifiedEdits(_text: string, lines: string[], strict: boolean): Edit[] {
  const sections: UnifiedSection[] = [];
  let i = 0;

  while (i < lines.length) {
    const l = lines[i]!;
    if (l.startsWith('diff --git ') || (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ '))) {
      // Start of a section
      let diffOld: string | null = null;
      let diffNew: string | null = null;
      if (l.startsWith('diff --git ')) {
        const m = l.match(/^diff --git \s*a\/(.+?)\s+b\/(.+)$/);
        if (!m) {
          throw new Exit2(`error: parse ${i + 1}`);
        }
        diffOld = m[1]!.trim();
        diffNew = m[2]!.trim();
        i++;
      }

      let headerOld: string | null = null;
      let headerNew: string | null = null;
      let renameOld: string | null = null;
      let renameNew: string | null = null;
      let isCreation = false;
      let isDeletion = false;

      // Parse header before first hunk
      while (i < lines.length) {
        const hl = lines[i]!;
        if (hl.startsWith('@@')) break; // Hunk starts
        if (hl.startsWith('diff --git ')) break; // Next section starts
        if (hl.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) {
          // --- line followed by +++ line
          headerOld = parseUnifiedPath(hl.slice(4));
          headerNew = parseUnifiedPath(lines[i + 1]!.slice(4));
          i += 2;
          continue;
        }
        if (hl.startsWith('--- ')) {
          // --- not followed by +++ in header
          throw new Exit2(`error: parse ${i + 2}`);
        }
        if (hl.startsWith('rename from ')) {
          renameOld = parseUnifiedPath(hl.slice(12));
        } else if (hl.startsWith('rename to ')) {
          renameNew = parseUnifiedPath(hl.slice(10));
        } else if (hl.startsWith('new file mode')) {
          isCreation = true;
        } else if (hl.startsWith('deleted file mode')) {
          isDeletion = true;
        }
        i++;
      }

      let finalOld = headerOld ?? renameOld ?? diffOld;
      let finalNew = headerNew ?? renameNew ?? diffNew;
      if (finalOld === '/dev/null') {
        finalOld = null;
        isCreation = true;
      }
      if (finalNew === '/dev/null') {
        finalNew = null;
        isDeletion = true;
      }

      const hunks: UnifiedHunk[] = [];

      // Parse hunks for this section
      while (i < lines.length) {
        const hl = lines[i]!;
        if (hl.startsWith('diff --git ')) break;
        if (hl.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) break;
        if (hl.startsWith('@@')) {
          const hm = hl.match(/^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
          if (!hm) {
            throw new Exit2(`error: parse ${i + 1}`);
          }
          const A = parseInt(hm[1]!, 10);
          const C = parseInt(hm[2]!, 10);
          i++;

          const O: string[] = [];
          const N_items: UnifiedHunkItem[] = [];
          let hunkEndsNoNewline = false;
          let lastAddedOrContextIndex = -1;

          while (i < lines.length) {
            const bl = lines[i]!;
            if (bl.startsWith('diff --git ')) break;
            if (bl.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) break;
            if (bl.startsWith('@@')) break;

            const c0 = bl[0];
            if (c0 === ' ') {
              const text = bl.slice(1);
              const oIdx = O.length;
              O.push(text);
              N_items.push({ type: ' ', line: text, O_index: oIdx });
              lastAddedOrContextIndex = N_items.length - 1;
            } else if (c0 === '-') {
              const text = bl.slice(1);
              O.push(text);
            } else if (c0 === '+') {
              const text = bl.slice(1);
              N_items.push({ type: '+', line: text });
              lastAddedOrContextIndex = N_items.length - 1;
            } else if (c0 === '\\') {
              if (lastAddedOrContextIndex === N_items.length - 1) {
                hunkEndsNoNewline = true;
              }
            } else if (bl === '') {
              const oIdx = O.length;
              O.push('');
              N_items.push({ type: ' ', line: '', O_index: oIdx });
              lastAddedOrContextIndex = N_items.length - 1;
            } else {
              // End of hunk body
              break;
            }
            i++;
          }

          // Trimming trailing empty lines outside body
          while (N_items.length > 0 && N_items[N_items.length - 1]!.type === ' ' && N_items[N_items.length - 1]!.line === '') {
            const popped = N_items.pop()!;
            if (popped.O_index !== undefined) {
              O.pop();
            }
          }

          hunks.push({ A, C, O, N_items, hunkEndsNoNewline });
        } else {
          // Lines outside body in section (prose / fences)
          i++;
        }
      }

      sections.push({
        oldPath: finalOld,
        newPath: finalNew,
        isCreation,
        isDeletion,
        hunks,
      });
    } else if (l.startsWith('@@')) {
      // Hunk header before any section
      throw new Exit2(`error: parse ${i + 1}`);
    } else {
      i++;
    }
  }

  if (sections.length === 0) throw new Exit2('error: parse 1');

  return sections.map((sec) => {
    return (tree: Tree, movePairs: MovePair[]) => {
      if (sec.isCreation) {
        const p = sec.newPath!;
        if (!safe(p)) throw new Fail('unsafe', p);
        if (tree.get(p) !== null) throw new Fail('exists', p);

        const linesOut: string[] = [];
        let endsNoNewline = false;
        for (const h of sec.hunks) {
          for (const item of h.N_items) {
            if (item.type === '+') linesOut.push(item.line);
          }
          if (h.hunkEndsNoNewline) endsNoNewline = true;
        }
        const textOut = linesOut.join('\n') + (endsNoNewline ? '' : '\n');
        tree.now.set(p, textOut);
      } else if (sec.isDeletion) {
        const p = sec.oldPath!;
        if (!safe(p)) throw new Fail('unsafe', p);
        if (tree.get(p) === null) throw new Fail('missing', p);
        tree.now.set(p, null);
      } else {
        const oldP = sec.oldPath!;
        const newP = sec.newPath!;
        const isMove = oldP !== newP;

        if (!safe(oldP)) throw new Fail('unsafe', oldP);
        if (tree.get(oldP) === null) throw new Fail('missing', oldP);

        if (isMove) {
          if (!safe(newP)) throw new Fail('unsafe', newP);
          if (tree.get(newP) !== null) throw new Fail('exists', newP);
        }

        const fc = parseFileText(tree.get(oldP)!);
        let d = 0;

        for (const h of sec.hunks) {
          if (h.O.length > 0) {
            const occRes = findOccurrences(fc.lines, h.O, strict);
            if (!occRes || occRes.occurrences.length === 0) {
              throw new Fail('no-match', oldP);
            }
            const T = h.A - 1 + d;
            let bestPos = occRes.occurrences[0]!;
            let bestDist = Math.abs(bestPos - T);
            for (let k = 1; k < occRes.occurrences.length; k++) {
              const pos = occRes.occurrences[k]!;
              const dist = Math.abs(pos - T);
              if (dist < bestDist) {
                bestDist = dist;
                bestPos = pos;
              }
            }

            const runsToEof = bestPos + h.O.length === fc.lines.length;
            if (runsToEof) {
              fc.hasFinalBreak = !h.hunkEndsNoNewline;
            }

            const N_out: string[] = [];
            for (const item of h.N_items) {
              if (item.type === ' ') {
                N_out.push(fc.lines[bestPos + item.O_index!]!);
              } else {
                if (occRes.tier === 2) {
                  N_out.push(applyTier2Reindent(item.line, fc.lines[bestPos]!, h.O[0]!));
                } else {
                  N_out.push(item.line);
                }
              }
            }

            fc.lines.splice(bestPos, h.O.length, ...N_out);
            d += N_out.length - h.O.length;
          } else {
            // O is empty
            const insertIdx = Math.max(0, Math.min(h.A + d, fc.lines.length));
            const runsToEof = insertIdx === fc.lines.length;
            if (runsToEof) {
              fc.hasFinalBreak = !h.hunkEndsNoNewline;
            }

            const N_out: string[] = [];
            for (const item of h.N_items) {
              N_out.push(item.line);
            }

            fc.lines.splice(insertIdx, 0, ...N_out);
            d += N_out.length;
          }
        }

        const resText = stringifyFileText(fc);
        if (isMove) {
          tree.now.set(oldP, null);
          tree.now.set(newP, resText);
          movePairs.push({ oldPath: oldP, newPath: newP });
        } else {
          tree.now.set(oldP, resText);
        }
      }
    };
  });
}

// SEARCH/REPLACE blocks (SPEC Section 7)

interface SearchReplaceBlock {
  path: string;
  O: string[];
  N: string[];
}

function searchReplaceEdits(_text: string, lines: string[], strict: boolean): Edit[] {
  const blocks: SearchReplaceBlock[] = [];
  let i = 0;
  let prevBlockEnd = 0;
  let prevPath: string | null = null;

  while (i < lines.length) {
    if (trimTrailing(lines[i]!) === '<<<<<<< SEARCH') {
      const searchLineNum = i + 1;
      let equalsIdx = -1;
      let replaceIdx = -1;

      for (let j = i + 1; j < lines.length; j++) {
        const l = trimTrailing(lines[j]!);
        if (l === '=======') {
          equalsIdx = j;
          for (let k = j + 1; k < lines.length; k++) {
            if (trimTrailing(lines[k]!) === '>>>>>>> REPLACE') {
              replaceIdx = k;
              break;
            }
          }
          break;
        }
      }

      if (equalsIdx < 0 || replaceIdx < 0) {
        throw new Exit2(`error: parse ${searchLineNum}`);
      }

      const O = lines.slice(i + 1, equalsIdx);
      const N = lines.slice(equalsIdx + 1, replaceIdx);

      // Find path line
      let path: string | null = null;
      for (let pIdx = i - 1; pIdx >= prevBlockEnd; pIdx--) {
        const candidate = lines[pIdx]!;
        if (!blank(candidate) && !candidate.trim().startsWith('```')) {
          path = candidate.trim();
          break;
        }
      }

      if (path === null) {
        path = prevPath;
      }
      if (path === null) {
        throw new Exit2(`error: parse ${searchLineNum}`);
      }

      blocks.push({ path, O, N });
      prevBlockEnd = replaceIdx + 1;
      prevPath = path;
      i = replaceIdx + 1;
    } else {
      i++;
    }
  }

  if (blocks.length === 0) throw new Exit2('error: parse 1');

  return blocks.map((b) => {
    return (tree: Tree) => {
      const p = b.path;
      if (!safe(p)) throw new Fail('unsafe', p);

      if (b.O.length === 0) {
        if (tree.get(p) !== null) throw new Fail('exists', p);
        tree.now.set(p, b.N.join('\n') + (b.N.length > 0 ? '\n' : ''));
      } else {
        const before = tree.get(p);
        if (before === null) throw new Fail('missing', p);
        const fc = parseFileText(before);

        const occRes = findOccurrences(fc.lines, b.O, strict);
        if (!occRes || occRes.occurrences.length === 0) {
          throw new Fail('no-match', p);
        }
        if (occRes.occurrences.length > 1) {
          throw new Fail('ambiguous', p);
        }

        const matchIdx = occRes.occurrences[0]!;
        const N_out: string[] = [];
        for (const l of b.N) {
          if (occRes.tier === 2) {
            N_out.push(applyTier2Reindent(l, fc.lines[matchIdx]!, b.O[0]!));
          } else {
            N_out.push(l);
          }
        }

        fc.lines.splice(matchIdx, b.O.length, ...N_out);
        tree.now.set(p, stringifyFileText(fc));
      }
    };
  });
}

// V4A Patches (SPEC Section 8)

interface V4AChunk {
  anchor: string | null;
  isEofChunk: boolean;
  O: string[];
  N_items: { type: ' ' | '-'; O_index?: number }[] | { type: '+' | ' '; line: string; O_index?: number }[];
}

interface V4ASectionAdd {
  type: 'add';
  path: string;
  lines: string[];
}

interface V4ASectionDelete {
  type: 'delete';
  path: string;
}

interface V4ASectionUpdate {
  type: 'update';
  path: string;
  moveTo: string | null;
  chunks: {
    anchor: string | null;
    isEofChunk: boolean;
    O: string[];
    N_items: { type: ' ' | '+' | '-'; line: string; O_index?: number }[];
  }[];
}

type V4ASection = V4ASectionAdd | V4ASectionDelete | V4ASectionUpdate;

function v4aEdits(_text: string, lines: string[], strict: boolean): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  if (lines[first]!.trim() !== '*** Begin Patch') throw new Exit2(`error: parse ${first + 1}`);

  let last = -1;
  for (let idx = lines.length - 1; idx >= 0; idx--) {
    if (!blank(lines[idx]!)) {
      last = idx;
      break;
    }
  }
  if (lines[last]!.trim() !== '*** End Patch') throw new Exit2(`error: parse ${lines.length + 1}`);

  const sections: V4ASection[] = [];
  let i = first + 1;

  while (i < last) {
    const l = lines[i]!;
    if (blank(l)) {
      i++;
      continue;
    }

    if (l.startsWith('*** Add File: ')) {
      const path = l.slice(14).trim();
      i++;
      const contentLines: string[] = [];
      while (i < last) {
        const bl = lines[i]!;
        if (bl.startsWith('*** Add File: ') || bl.startsWith('*** Delete File: ') || bl.startsWith('*** Update File: ')) break;
        if (blank(bl)) {
          // Check if trailing blank line before section
          let peek = i + 1;
          while (peek < last && blank(lines[peek]!)) peek++;
          if (peek === last || lines[peek]!.startsWith('*** ')) {
            i = peek;
            break;
          }
        }
        if (bl.startsWith('+')) {
          contentLines.push(bl.slice(1));
        } else if (bl === '') {
          contentLines.push('');
        } else {
          throw new Exit2(`error: parse ${i + 1}`);
        }
        i++;
      }
      sections.push({ type: 'add', path, lines: contentLines });
    } else if (l.startsWith('*** Delete File: ')) {
      const path = l.slice(17).trim();
      i++;
      while (i < last) {
        const bl = lines[i]!;
        if (bl.startsWith('*** Add File: ') || bl.startsWith('*** Delete File: ') || bl.startsWith('*** Update File: ')) break;
        if (blank(bl)) {
          i++;
          continue;
        }
        throw new Exit2(`error: parse ${i + 1}`);
      }
      sections.push({ type: 'delete', path });
    } else if (l.startsWith('*** Update File: ')) {
      const updateLineNum = i + 1;
      const path = l.slice(17).trim();
      i++;

      let moveTo: string | null = null;
      if (i < last && lines[i]!.startsWith('*** Move to: ')) {
        moveTo = lines[i]!.slice(13).trim();
        i++;
      }

      const chunks: V4ASectionUpdate['chunks'] = [];

      while (i < last) {
        const cl = lines[i]!;
        if (blank(cl)) {
          let peek = i + 1;
          while (peek < last && blank(lines[peek]!)) peek++;
          if (peek === last || lines[peek]!.startsWith('*** ')) {
            i = peek;
            break;
          }
        }
        if (cl.startsWith('*** Add File: ') || cl.startsWith('*** Delete File: ') || cl.startsWith('*** Update File: ')) break;

        let anchor: string | null = null;
        if (cl.startsWith('@@')) {
          const aText = cl.slice(2).trim();
          anchor = aText === '' ? null : aText;
          i++;
        }

        const O: string[] = [];
        const N_items: { type: ' ' | '+' | '-'; line: string; O_index?: number }[] = [];
        let isEofChunk = false;

        while (i < last) {
          const bl = lines[i]!;
          if (bl.startsWith('*** Add File: ') || bl.startsWith('*** Delete File: ') || bl.startsWith('*** Update File: ')) break;
          if (bl.startsWith('@@')) break;
          if (bl === '*** End of File') {
            isEofChunk = true;
            i++;
            break;
          }

          if (blank(bl)) {
            // SPEC 8: a blank line (empty or whitespace-only) at the end of
            // a section, before the next section or *** End Patch, is not
            // part of the chunk. A blank line is a context line only when a
            // body line follows it in this chunk.
            let peek = i + 1;
            while (peek < last && blank(lines[peek]!)) peek++;
            if (peek >= last || lines[peek]!.startsWith('*** ')) break;
          }

          const c0 = bl[0];
          if (c0 === ' ') {
            const text = bl.slice(1);
            const oIdx = O.length;
            O.push(text);
            N_items.push({ type: ' ', line: text, O_index: oIdx });
          } else if (c0 === '-') {
            const text = bl.slice(1);
            O.push(text);
          } else if (c0 === '+') {
            const text = bl.slice(1);
            N_items.push({ type: '+', line: text });
          } else if (bl === '') {
            const oIdx = O.length;
            O.push('');
            N_items.push({ type: ' ', line: '', O_index: oIdx });
          } else {
            throw new Exit2(`error: parse ${i + 1}`);
          }
          i++;
        }

        chunks.push({ anchor, isEofChunk, O, N_items });
      }

      if (chunks.length === 0 && moveTo === null) {
        throw new Exit2(`error: parse ${updateLineNum}`);
      }

      sections.push({ type: 'update', path, moveTo, chunks });
    } else {
      throw new Exit2(`error: parse ${i + 1}`);
    }
  }

  if (sections.length === 0) throw new Exit2('error: parse 1');

  return sections.map((sec) => {
    return (tree: Tree, movePairs: MovePair[]) => {
      if (sec.type === 'add') {
        const p = sec.path;
        if (!safe(p)) throw new Fail('unsafe', p);
        if (tree.get(p) !== null) throw new Fail('exists', p);
        tree.now.set(p, sec.lines.join('\n') + '\n');
      } else if (sec.type === 'delete') {
        const p = sec.path;
        if (!safe(p)) throw new Fail('unsafe', p);
        if (tree.get(p) === null) throw new Fail('missing', p);
        tree.now.set(p, null);
      } else if (sec.type === 'update') {
        const p = sec.path;
        const moveTo = sec.moveTo;

        if (!safe(p)) throw new Fail('unsafe', p);
        if (tree.get(p) === null) throw new Fail('missing', p);
        if (moveTo !== null) {
          if (!safe(moveTo)) throw new Fail('unsafe', moveTo);
          if (tree.get(moveTo) !== null) throw new Fail('exists', moveTo);
        }

        const fc = parseFileText(tree.get(p)!);
        let cursor = 0;

        for (const chunk of sec.chunks) {
          if (chunk.anchor !== null) {
            const foundIdx = findAnchorAtOrAfter(fc.lines, chunk.anchor, strict, cursor);

            if (foundIdx < 0) {
              throw new Fail('no-match', p);
            }
            cursor = foundIdx + 1;
          }

          if (chunk.O.length > 0) {
            const occRes = findOccurrences(fc.lines, chunk.O, strict, cursor);
            if (!occRes || occRes.occurrences.length === 0) {
              throw new Fail('no-match', p);
            }

            let pos = -1;
            if (chunk.isEofChunk) {
              const eofPos = occRes.occurrences.find((oPos) => oPos + chunk.O.length === fc.lines.length);
              if (eofPos === undefined) throw new Fail('no-match', p);
              pos = eofPos;
            } else {
              pos = occRes.occurrences[0]!;
            }

            const N_out: string[] = [];
            for (const item of chunk.N_items) {
              if (item.type === ' ') {
                N_out.push(fc.lines[pos + item.O_index!]!);
              } else if (item.type === '+') {
                if (occRes.tier === 2) {
                  N_out.push(applyTier2Reindent(item.line, fc.lines[pos]!, chunk.O[0]!));
                } else {
                  N_out.push(item.line);
                }
              }
            }

            fc.lines.splice(pos, chunk.O.length, ...N_out);
            cursor = pos + N_out.length;
          } else {
            // O is empty
            const insertIdx = chunk.isEofChunk ? fc.lines.length : cursor;
            const N_out: string[] = [];
            for (const item of chunk.N_items) {
              if (item.type === '+') {
                N_out.push(item.line);
              }
            }
            fc.lines.splice(insertIdx, 0, ...N_out);
            cursor = insertIdx + N_out.length;
          }
        }

        const resText = stringifyFileText(fc);
        if (moveTo !== null) {
          tree.now.set(p, null);
          tree.now.set(moveTo, resText);
          movePairs.push({ oldPath: p, newPath: moveTo });
        } else {
          tree.now.set(p, resText);
        }
      }
    };
  });
}

function run(args: string[]): { code: number; out: string[] } {
  let format: string | null = null;
  let check = false;
  let strict = false;
  const pos: string[] = [];
  let ended = false;
  for (const a of args) {
    if (!ended && a === '--') ended = true;
    else if (!ended && a.startsWith('-') && a !== '-') {
      if (a.startsWith('--format=') && format === null && FORMATS.includes(a.slice(9))) format = a.slice(9);
      else if (a === '--check' && !check) check = true;
      else if (a === '--strict' && !strict) strict = true;
      else return { code: 2, out: ['error: usage'] };
    } else pos.push(a);
  }
  if (pos.length > 1) return { code: 2, out: ['error: usage'] };
  const file = pos.length === 0 || pos[0] === '-' ? null : pos[0]!;
  let text = '';
  try {
    text = readFileSync(file ?? 0, 'utf8');
  } catch {
    if (file !== null) return { code: 2, out: ['error: no-patch'] };
  }
  const lines = patchLines(text);
  const kind = format === null || format === 'auto' ? detect(lines) : format;
  if (kind === null) return { code: 2, out: ['error: format'] };
  let edits: Edit[];
  try {
    if (kind === 'json') edits = jsonEdits(text, lines);
    else if (kind === 'unified') edits = unifiedEdits(text, lines, strict);
    else if (kind === 'search-replace') edits = searchReplaceEdits(text, lines, strict);
    else if (kind === 'v4a') edits = v4aEdits(text, lines, strict);
    else edits = [];

    if (edits.length === 0) throw new Exit2('error: parse 1');
  } catch (e) {
    if (e instanceof Exit2) return { code: 2, out: [e.line] };
    throw e;
  }
  const tree = new Tree();
  const movePairs: MovePair[] = [];
  const fails: Fail[] = [];
  for (const edit of edits) {
    const before = new Map(tree.now);
    try {
      edit(tree, movePairs);
    } catch (e) {
      if (!(e instanceof Fail)) throw e;
      tree.now.clear();
      for (const [k, v] of before) tree.now.set(k, v);
      fails.push(e);
    }
  }
  if (fails.length > 0) return { code: 1, out: [...fails.map((f) => `error: ${f.code} ${f.path}`), `failed: ${fails.length} of ${edits.length} edits`] };

  // Determine active move pairs
  const activeMoves = movePairs.filter(
    (mp) => tree.original(mp.oldPath) !== null && tree.now.get(mp.oldPath) === null && tree.original(mp.newPath) === null && tree.now.get(mp.newPath) !== null
  );

  const movedOldPaths = new Set(activeMoves.map((m) => m.oldPath));
  const movedNewPaths = new Set(activeMoves.map((m) => m.newPath));

  const rows: { text: string; key: string }[] = [];

  for (const p of tree.now.keys()) {
    if (movedOldPaths.has(p) || movedNewPaths.has(p)) continue;
    const was = tree.original(p);
    const now = tree.now.get(p)!;
    if (was === now) continue;
    rows.push({
      text: `${was === null ? 'A' : now === null ? 'D' : 'M'} ${p}`,
      key: p,
    });
  }

  for (const mp of activeMoves) {
    rows.push({
      text: `R ${mp.oldPath} -> ${mp.newPath}`,
      key: mp.newPath,
    });
  }

  rows.sort((a, b) => Buffer.compare(Buffer.from(a.key), Buffer.from(b.key)));

  for (const r of rows) {
    if (check) continue;
    // Perform disk writes
    const p = r.key;
    if (r.text.startsWith('R ')) {
      // Move pair: delete old, create new
      const m = r.text.match(/^R (.+?) -> (.+)$/);
      if (m) {
        const oldP = m[1]!;
        const newP = m[2]!;
        rmSync(oldP, { force: true });
        const content = tree.now.get(newP);
        if (content !== null) {
          mkdirSync(dirname(newP), { recursive: true });
          writeFileSync(newP, content);
        }
      }
    } else {
      const content = tree.now.get(p);
      if (content === null) rmSync(p, { force: true });
      else if (content !== undefined) {
        mkdirSync(dirname(p), { recursive: true });
        writeFileSync(p, content);
      }
    }
  }

  return { code: 0, out: [...rows.map((r) => r.text), `ok: ${rows.length} ${rows.length === 1 ? 'file' : 'files'}`] };
}

const trialEnv = process.env.MAKEFUN_ENV_URL;
if (trialEnv !== undefined && trialEnv !== '') {
  // A trial: the kit's runner reads the checks from the env and runs this file on each one, without this variable.
  const { runTrial } = await import('./runner.ts');
  await runTrial(trialEnv);
} else {
  const r = run(process.argv.slice(2));
  writeSync(1, r.out.map((l) => `${l}\n`).join(''));
  process.exitCode = r.code;
}
