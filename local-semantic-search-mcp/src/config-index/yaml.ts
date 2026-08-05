// A dependency-free, bounded parser for the YAML SUBSET that machine-generated
// config uses (Drupal `config/sync` exports, `*.services.yml`, `*.routing.yml`,
// `*.info.yml`, …). These files are regular: 2-space block indentation, no
// anchors/tags/multi-document streams, simple scalars. We deliberately do NOT
// aim for full YAML 1.2 — only enough structure for the config summarizers to
// pull out ids, labels, dependencies and key fields. It is defensive: anything
// it can't parse is skipped rather than thrown, so a weird file degrades to a
// thinner summary instead of failing the whole config build.

export type YamlValue =
  | string
  | number
  | boolean
  | null
  | YamlValue[]
  | { [key: string]: YamlValue };

interface Line {
  indent: number;
  text: string;
}

// Guardrail: config files are small; refuse to parse anything pathological so a
// stray huge/degenerate file can't stall the build.
const MAX_LINES = 5000;

export function parseYaml(source: string): YamlValue {
  const lines: Line[] = [];
  for (const raw of source.split(/\r?\n/)) {
    const trimmed = raw.trim();
    if (trimmed === '' || trimmed.startsWith('#') || trimmed === '---' || trimmed === '...') {
      continue;
    }
    const indent = raw.length - raw.replace(/^ +/, '').length;
    lines.push({ indent, text: raw.slice(indent).replace(/\s+$/, '') });
    if (lines.length >= MAX_LINES) break;
  }
  if (lines.length === 0) return null;
  const [value] = parseNode(lines, 0, lines[0].indent);
  return value;
}

function parseNode(lines: Line[], i: number, indent: number): [YamlValue, number] {
  if (i >= lines.length) return [null, i];
  const t = lines[i].text;
  if (t === '-' || t.startsWith('- ')) return parseSeq(lines, i, indent);
  return parseMap(lines, i, indent);
}

function parseMap(lines: Line[], i: number, indent: number): [Record<string, YamlValue>, number] {
  const obj: Record<string, YamlValue> = {};
  while (i < lines.length) {
    const line = lines[i];
    if (line.indent < indent) break;
    if (line.indent > indent) {
      i++; // stray over-indent — skip defensively
      continue;
    }
    if (line.text === '-' || line.text.startsWith('- ')) break; // a sequence, not a map
    const kv = splitKey(line.text);
    if (!kv) {
      i++;
      continue;
    }
    const { key, rest } = kv;
    if (rest === '') {
      const next = lines[i + 1];
      if (next && next.indent > indent) {
        const [child, ni] = parseNode(lines, i + 1, next.indent);
        obj[key] = child;
        i = ni;
      } else if (next && next.indent === indent && (next.text === '-' || next.text.startsWith('- '))) {
        // A block sequence written at the same indent as its key.
        const [child, ni] = parseSeq(lines, i + 1, indent);
        obj[key] = child;
        i = ni;
      } else {
        obj[key] = null;
        i++;
      }
    } else {
      obj[key] = parseScalar(rest);
      i++;
    }
  }
  return [obj, i];
}

function parseSeq(lines: Line[], i: number, indent: number): [YamlValue[], number] {
  const arr: YamlValue[] = [];
  while (i < lines.length) {
    const line = lines[i];
    if (line.indent < indent) break;
    if (line.indent > indent) {
      i++;
      continue;
    }
    if (!(line.text === '-' || line.text.startsWith('- '))) break;
    const rest = line.text === '-' ? '' : line.text.slice(2);
    if (rest === '') {
      const next = lines[i + 1];
      if (next && next.indent > indent) {
        const [child, ni] = parseNode(lines, i + 1, next.indent);
        arr.push(child);
        i = ni;
      } else {
        arr.push(null);
        i++;
      }
    } else if (rest.startsWith('{') || rest.startsWith('[')) {
      // "- { name: foo }" / "- [a, b]" — a flow collection item, not a block map.
      arr.push(parseScalar(rest));
      i++;
    } else if (splitKey(rest)) {
      // "- key: value" — a mapping whose first key sits at column indent+2.
      // Rewrite this line as a plain map line at that indent and let parseMap
      // consume it together with any following keys of the same item.
      const itemIndent = indent + 2;
      lines[i] = { indent: itemIndent, text: rest };
      const [child, ni] = parseMap(lines, i, itemIndent);
      arr.push(child);
      i = ni;
    } else {
      arr.push(parseScalar(rest));
      i++;
    }
  }
  return [arr, i];
}

// Split a mapping line into key + remaining scalar/empty. Handles quoted keys
// (`'a.b': value`). Returns null when the line isn't a `key:`/`key: value` pair.
function splitKey(text: string): { key: string; rest: string } | null {
  if (text.startsWith("'") || text.startsWith('"')) {
    const q = text[0];
    const end = text.indexOf(q, 1);
    if (end === -1) return null;
    const after = text.slice(end + 1);
    const m = after.match(/^\s*:(?:\s+(.*))?$/);
    if (!m) return null;
    return { key: text.slice(1, end), rest: m[1] ?? '' };
  }
  const m = text.match(/^([^:]+):(?:\s+(.*))?$/);
  if (!m) return null;
  return { key: m[1].trim(), rest: m[2] ?? '' };
}

function parseScalar(raw: string): YamlValue {
  const s = raw.trim();
  if (s === '' || s === '~' || s === 'null' || s === 'Null' || s === 'NULL') return null;
  if (s === 'true' || s === 'True' || s === 'TRUE') return true;
  if (s === 'false' || s === 'False' || s === 'FALSE') return false;
  if (/^-?\d+$/.test(s)) return parseInt(s, 10);
  if (/^-?\d+\.\d+$/.test(s)) return parseFloat(s);
  if (s.length >= 2 && s.startsWith("'") && s.endsWith("'")) {
    return s.slice(1, -1).replace(/''/g, "'");
  }
  if (s.length >= 2 && s.startsWith('"') && s.endsWith('"')) {
    return s
      .slice(1, -1)
      .replace(/\\"/g, '"')
      .replace(/\\n/g, '\n')
      .replace(/\\t/g, '\t')
      .replace(/\\\\/g, '\\');
  }
  if (s === '[]' || s === '{}') return s === '[]' ? [] : {};
  if (s.startsWith('[') && s.endsWith(']')) return parseFlowSeq(s.slice(1, -1));
  if (s.startsWith('{') && s.endsWith('}')) return parseFlowMap(s.slice(1, -1));
  return s;
}

// Minimal single-level flow collections — Drupal uses these only for short
// inline lists/maps. Nested flow isn't attempted (rare in config).
function parseFlowSeq(inner: string): YamlValue[] {
  return splitTopLevel(inner).map((p) => parseScalar(p));
}

function parseFlowMap(inner: string): Record<string, YamlValue> {
  const obj: Record<string, YamlValue> = {};
  for (const part of splitTopLevel(inner)) {
    const kv = splitKey(part.trim());
    if (kv) obj[kv.key] = parseScalar(kv.rest);
  }
  return obj;
}

function splitTopLevel(inner: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let quote: string | null = null;
  let cur = '';
  for (const ch of inner) {
    if (quote) {
      cur += ch;
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === "'" || ch === '"') {
      quote = ch;
      cur += ch;
    } else if (ch === '[' || ch === '{') {
      depth++;
      cur += ch;
    } else if (ch === ']' || ch === '}') {
      depth--;
      cur += ch;
    } else if (ch === ',' && depth === 0) {
      if (cur.trim() !== '') out.push(cur.trim());
      cur = '';
    } else {
      cur += ch;
    }
  }
  if (cur.trim() !== '') out.push(cur.trim());
  return out;
}
