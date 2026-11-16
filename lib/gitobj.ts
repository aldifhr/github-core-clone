/**
 * The git object model, in memory: blobs, trees, commits and annotated tags
 * addressed by their SHA-1, plus the pkt-line codec and packfile read/write
 * the smart-HTTP transport is built from. Plain packs (no deltas) are written;
 * packs are read with OFS_DELTA / REF_DELTA resolution so a real git client's
 * thin or deltified push is still understood.
 */
import { createHash } from 'node:crypto';
import { deflateSync, inflateSync } from 'node:zlib';

export type GitObjectType = 'blob' | 'tree' | 'commit' | 'tag';

export interface GitObject {
  type: GitObjectType;
  /** The raw object payload (no `<type> <len>\0` header). */
  data: Buffer;
}

export const ZERO_OID = '0000000000000000000000000000000000000000';
const TYPE_TO_CODE: Record<GitObjectType, number> = { commit: 1, tree: 2, blob: 3, tag: 4 };
const CODE_TO_TYPE: Record<number, GitObjectType> = { 1: 'commit', 2: 'tree', 3: 'blob', 4: 'tag' };

export function hashObject(type: GitObjectType, data: Buffer): string {
  const hash = createHash('sha1');
  hash.update(`${type} ${data.length}\0`, 'utf8');
  hash.update(data);
  return hash.digest('hex');
}

/** Insert (or find) an object in a store; returns its oid. */
export function storeObject(store: Map<string, GitObject>, type: GitObjectType, data: Buffer): string {
  const oid = hashObject(type, data);
  if (!store.has(oid)) store.set(oid, { type, data });
  return oid;
}

// ------------------------------------------------------------------ commits

export interface CommitInfo {
  tree: string;
  parents: string[];
  authorName: string;
  authorEmail: string;
  authorTs: number;
  committerName: string;
  committerEmail: string;
  committerTs: number;
  message: string;
}

function parseIdent(line: string): { name: string; email: string; ts: number } {
  const match = /^(.*?) <(.*?)> (\d+) [+-]\d{4}$/.exec(line);
  if (!match) return { name: line, email: '', ts: 0 };
  return { name: match[1], email: match[2], ts: Number(match[3]) };
}

export function parseCommit(data: Buffer): CommitInfo {
  const text = data.toString('utf8');
  const split = text.indexOf('\n\n');
  const head = split === -1 ? text : text.slice(0, split);
  const message = split === -1 ? '' : text.slice(split + 2);
  const info: CommitInfo = {
    tree: ZERO_OID,
    parents: [],
    authorName: '',
    authorEmail: '',
    authorTs: 0,
    committerName: '',
    committerEmail: '',
    committerTs: 0,
    message,
  };
  for (const line of head.split('\n')) {
    if (line.startsWith('tree ')) info.tree = line.slice(5).trim();
    else if (line.startsWith('parent ')) info.parents.push(line.slice(7).trim());
    else if (line.startsWith('author ')) {
      const ident = parseIdent(line.slice(7));
      info.authorName = ident.name; info.authorEmail = ident.email; info.authorTs = ident.ts;
    } else if (line.startsWith('committer ')) {
      const ident = parseIdent(line.slice(10));
      info.committerName = ident.name; info.committerEmail = ident.email; info.committerTs = ident.ts;
    }
  }
  return info;
}

export function buildCommit(info: CommitInfo): Buffer {
  const lines: string[] = [`tree ${info.tree}`];
  for (const parent of info.parents) lines.push(`parent ${parent}`);
  lines.push(`author ${info.authorName} <${info.authorEmail}> ${info.authorTs} +0000`);
  lines.push(`committer ${info.committerName} <${info.committerEmail}> ${info.committerTs} +0000`);
  return Buffer.from(`${lines.join('\n')}\n\n${info.message}`, 'utf8');
}

/** The commit a tag object points at, following nested tags; null if it is not tag-shaped. */
export function parseTagTarget(data: Buffer): { object: string; type: string } | null {
  const text = data.toString('utf8');
  let object = '';
  let type = '';
  for (const line of text.split('\n')) {
    if (line === '') break;
    if (line.startsWith('object ')) object = line.slice(7).trim();
    else if (line.startsWith('type ')) type = line.slice(5).trim();
  }
  if (!/^[0-9a-f]{40}$/.test(object)) return null;
  return { object, type };
}

/** Peel an oid through tag objects to the commit beneath; the oid itself if it already is one. */
export function peelToCommit(store: Map<string, GitObject>, oid: string): string | null {
  let current = oid;
  for (let depth = 0; depth < 16; depth += 1) {
    const object = store.get(current);
    if (!object) return null;
    if (object.type === 'commit') return current;
    if (object.type !== 'tag') return null;
    const target = parseTagTarget(object.data);
    if (!target) return null;
    current = target.object;
  }
  return null;
}

// -------------------------------------------------------------------- trees

export interface TreeEntry {
  mode: string; // '100644' | '100755' | '120000' | '40000' (dir, as stored: no leading zero)
  name: string;
  oid: string;
}

export function parseTree(data: Buffer): TreeEntry[] {
  const entries: TreeEntry[] = [];
  let pos = 0;
  while (pos < data.length) {
    const space = data.indexOf(0x20, pos);
    const mode = data.toString('ascii', pos, space);
    const nul = data.indexOf(0x00, space + 1);
    const name = data.toString('utf8', space + 1, nul);
    const oid = data.toString('hex', nul + 1, nul + 21);
    entries.push({ mode, name, oid });
    pos = nul + 21;
  }
  return entries;
}

function treeSortKey(entry: TreeEntry): string {
  // Git orders tree entries bytewise, directories as if their name ended in '/'.
  return entry.mode === '40000' ? `${entry.name}/` : entry.name;
}

export function buildTree(entries: TreeEntry[]): Buffer {
  const sorted = [...entries].sort((a, b) => (treeSortKey(a) < treeSortKey(b) ? -1 : treeSortKey(a) > treeSortKey(b) ? 1 : 0));
  const parts: Buffer[] = [];
  for (const entry of sorted) {
    parts.push(Buffer.from(`${entry.mode} ${entry.name}\0`, 'utf8'));
    parts.push(Buffer.from(entry.oid, 'hex'));
  }
  return Buffer.concat(parts);
}

export interface FlatEntry {
  oid: string;
  mode: string;
}

/** Every blob under a tree, keyed by slash-joined path. Missing tree ⇒ empty map. */
export function flattenTree(store: Map<string, GitObject>, treeOid: string): Map<string, FlatEntry> {
  const out = new Map<string, FlatEntry>();
  const walk = (oid: string, prefix: string): void => {
    const object = store.get(oid);
    if (!object || object.type !== 'tree') return;
    for (const entry of parseTree(object.data)) {
      const path = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
      if (entry.mode === '40000') walk(entry.oid, path);
      else out.set(path, { oid: entry.oid, mode: entry.mode });
    }
  };
  walk(treeOid, '');
  return out;
}

/** The entries of the tree at `path` ('' = root); null when any hop is missing. */
export function treeAtPath(store: Map<string, GitObject>, rootTree: string, path: string): TreeEntry[] | null {
  if (path === '') {
    const object = store.get(rootTree);
    return object && object.type === 'tree' ? parseTree(object.data) : null;
  }
  let current = rootTree;
  for (const segment of path.split('/')) {
    const object = store.get(current);
    if (!object || object.type !== 'tree') return null;
    const entry = parseTree(object.data).find((candidate) => candidate.name === segment && candidate.mode === '40000');
    if (!entry) return null;
    current = entry.oid;
  }
  const object = store.get(current);
  return object && object.type === 'tree' ? parseTree(object.data) : null;
}

/** Build (and store) nested trees from a flat path map; returns the root tree oid. */
export function buildTreeFromFlat(store: Map<string, GitObject>, flat: Map<string, FlatEntry>): string {
  interface DirNode { dirs: Map<string, DirNode>; files: TreeEntry[] }
  const root: DirNode = { dirs: new Map(), files: [] };
  for (const [path, entry] of flat) {
    const segments = path.split('/');
    let node = root;
    for (let i = 0; i < segments.length - 1; i += 1) {
      let next = node.dirs.get(segments[i]);
      if (!next) {
        next = { dirs: new Map(), files: [] };
        node.dirs.set(segments[i], next);
      }
      node = next;
    }
    node.files.push({ mode: entry.mode, name: segments[segments.length - 1], oid: entry.oid });
  }
  const emit = (node: DirNode): string => {
    const entries: TreeEntry[] = [...node.files];
    for (const [name, child] of node.dirs) entries.push({ mode: '40000', name, oid: emit(child) });
    return storeObject(store, 'tree', buildTree(entries));
  };
  return emit(root);
}

/** The tree oid of a commit, or null when the oid is not a known commit. */
export function commitTree(store: Map<string, GitObject>, commitOid: string): string | null {
  const object = store.get(commitOid);
  if (!object || object.type !== 'commit') return null;
  return parseCommit(object.data).tree;
}

// ----------------------------------------------------------------- pkt-line

/** One pkt-line: 4 hex digits of total length, then the payload. */
export function pktLine(payload: Buffer | string): Buffer {
  const body = typeof payload === 'string' ? Buffer.from(payload, 'utf8') : payload;
  const length = body.length + 4;
  const header = length.toString(16).padStart(4, '0');
  return Buffer.concat([Buffer.from(header, 'ascii'), body]);
}

export const PKT_FLUSH = Buffer.from('0000', 'ascii');
export const PKT_DELIM = Buffer.from('0001', 'ascii');

export interface PktFrame {
  /** Payload bytes; null marks a flush packet, 'delim' a delimiter packet. */
  payload: Buffer | null | 'delim';
  next: number;
}

export function readPktFrame(buffer: Buffer, offset: number): PktFrame | null {
  if (offset + 4 > buffer.length) return null;
  const hex = buffer.toString('ascii', offset, offset + 4);
  if (!/^[0-9a-fA-F]{4}$/.test(hex)) return null;
  const length = parseInt(hex, 16);
  if (length === 0) return { payload: null, next: offset + 4 };
  if (length === 1) return { payload: 'delim', next: offset + 4 };
  if (length < 4 || offset + length > buffer.length) return null;
  return { payload: buffer.subarray(offset + 4, offset + length), next: offset + length };
}

/** Split a buffer into pkt-line frames until the first flush (or the bytes run out). */
export function readPktLines(buffer: Buffer, offset = 0): { frames: (Buffer | 'delim')[]; next: number; flushed: boolean } {
  const frames: (Buffer | 'delim')[] = [];
  let pos = offset;
  for (;;) {
    const frame = readPktFrame(buffer, pos);
    if (!frame) return { frames, next: pos, flushed: false };
    pos = frame.next;
    if (frame.payload === null) return { frames, next: pos, flushed: true };
    frames.push(frame.payload);
  }
}

// --------------------------------------------------------------------- pack

/** A plain packfile (version 2, no deltas) over the given objects, in the given order. */
export function buildPack(store: Map<string, GitObject>, oids: string[]): Buffer {
  const parts: Buffer[] = [];
  const header = Buffer.alloc(12);
  header.write('PACK', 0, 'ascii');
  header.writeUInt32BE(2, 4);
  header.writeUInt32BE(oids.length, 8);
  parts.push(header);
  for (const oid of oids) {
    const object = store.get(oid);
    if (!object) throw new Error(`pack: unknown object ${oid}`);
    const code = TYPE_TO_CODE[object.type];
    let size = object.data.length;
    const headBytes: number[] = [];
    let first = (code << 4) | (size & 0x0f);
    size >>= 4;
    if (size > 0) first |= 0x80;
    headBytes.push(first);
    while (size > 0) {
      let byte = size & 0x7f;
      size >>= 7;
      if (size > 0) byte |= 0x80;
      headBytes.push(byte);
    }
    parts.push(Buffer.from(headBytes));
    parts.push(deflateSync(object.data));
  }
  const body = Buffer.concat(parts);
  const trailer = createHash('sha1').update(body).digest();
  return Buffer.concat([body, trailer]);
}

function applyDelta(base: Buffer, delta: Buffer): Buffer {
  let pos = 0;
  const readVarint = (): number => {
    let value = 0;
    let shift = 0;
    for (;;) {
      const byte = delta[pos];
      pos += 1;
      value |= (byte & 0x7f) << shift;
      shift += 7;
      if ((byte & 0x80) === 0) break;
    }
    return value;
  };
  const sourceSize = readVarint();
  if (sourceSize !== base.length) throw new Error('pack delta: base size mismatch');
  const targetSize = readVarint();
  const out: Buffer[] = [];
  let produced = 0;
  while (pos < delta.length) {
    const opcode = delta[pos];
    pos += 1;
    if (opcode & 0x80) {
      let offset = 0;
      let size = 0;
      for (let i = 0; i < 4; i += 1) {
        if (opcode & (1 << i)) {
          offset |= delta[pos] << (8 * i);
          pos += 1;
        }
      }
      for (let i = 0; i < 3; i += 1) {
        if (opcode & (0x10 << i)) {
          size |= delta[pos] << (8 * i);
          pos += 1;
        }
      }
      if (size === 0) size = 0x10000;
      out.push(base.subarray(offset, offset + size));
      produced += size;
    } else if (opcode > 0) {
      out.push(delta.subarray(pos, pos + opcode));
      produced += opcode;
      pos += opcode;
    } else {
      throw new Error('pack delta: zero opcode');
    }
  }
  const result = Buffer.concat(out);
  if (result.length !== targetSize || produced !== targetSize) throw new Error('pack delta: target size mismatch');
  return result;
}

interface PackEntry {
  type: GitObjectType;
  data?: Buffer;
  deltaBaseOid?: string;
  deltaBaseOffset?: number;
  entryStart: number;
}

/**
 * Parse a packfile into `store` (existing store objects may serve as REF_DELTA
 * bases, which is what makes a thin push work). Returns the new objects' oids.
 */
export function parsePackInto(store: Map<string, GitObject>, pack: Buffer): string[] {
  if (pack.length < 12 + 20 || pack.toString('ascii', 0, 4) !== 'PACK') throw new Error('not a packfile');
  const version = pack.readUInt32BE(4);
  if (version !== 2 && version !== 3) throw new Error(`unsupported pack version ${version}`);
  const count = pack.readUInt32BE(8);
  let pos = 12;
  const entries: PackEntry[] = [];
  for (let i = 0; i < count; i += 1) {
    const entryStart = pos;
    let byte = pack[pos];
    pos += 1;
    const code = (byte >> 4) & 0x07;
    let size = byte & 0x0f;
    let shift = 4;
    while (byte & 0x80) {
      byte = pack[pos];
      pos += 1;
      size |= (byte & 0x7f) << shift;
      shift += 7;
    }
    let deltaBaseOid: string | undefined;
    let deltaBaseOffset: number | undefined;
    if (code === 6) {
      // OFS_DELTA: a negative offset to the base entry's start.
      let back = pack[pos];
      pos += 1;
      let offset = back & 0x7f;
      while (back & 0x80) {
        back = pack[pos];
        pos += 1;
        offset = ((offset + 1) << 7) | (back & 0x7f);
      }
      deltaBaseOffset = entryStart - offset;
    } else if (code === 7) {
      deltaBaseOid = pack.toString('hex', pos, pos + 20);
      pos += 20;
    }
    const inflated = inflateSync(pack.subarray(pos), { info: true }) as unknown as { buffer: Buffer; engine: { bytesWritten: number } };
    pos += inflated.engine.bytesWritten;
    if (inflated.buffer.length !== size) throw new Error('pack: inflated size mismatch');
    if (code === 6 || code === 7) {
      entries.push({ type: 'blob', data: inflated.buffer, deltaBaseOid, deltaBaseOffset, entryStart });
    } else {
      const type = CODE_TO_TYPE[code];
      if (!type) throw new Error(`pack: unknown object type code ${code}`);
      entries.push({ type, data: inflated.buffer, entryStart });
    }
  }
  // Resolve deltas (entries may chain; iterate until all resolve).
  const byStart = new Map<number, PackEntry>();
  for (const entry of entries) byStart.set(entry.entryStart, entry);
  const resolved = new Map<PackEntry, GitObject>();
  const resolve = (entry: PackEntry, depth: number): GitObject => {
    const cached = resolved.get(entry);
    if (cached) return cached;
    if (depth > 64) throw new Error('pack: delta chain too deep');
    let object: GitObject;
    if (entry.deltaBaseOid === undefined && entry.deltaBaseOffset === undefined) {
      object = { type: entry.type, data: entry.data as Buffer };
    } else {
      let base: GitObject;
      if (entry.deltaBaseOid !== undefined) {
        const fromPack = entries.find((candidate) => {
          if (candidate.deltaBaseOid !== undefined || candidate.deltaBaseOffset !== undefined) return false;
          return hashObject(candidate.type, candidate.data as Buffer) === entry.deltaBaseOid;
        });
        if (fromPack) base = resolve(fromPack, depth + 1);
        else {
          const stored = store.get(entry.deltaBaseOid);
          if (!stored) throw new Error(`pack: delta base ${entry.deltaBaseOid} not available`);
          base = stored;
        }
      } else {
        const baseEntry = byStart.get(entry.deltaBaseOffset as number);
        if (!baseEntry) throw new Error('pack: ofs-delta base missing');
        base = resolve(baseEntry, depth + 1);
      }
      object = { type: base.type, data: applyDelta(base.data, entry.data as Buffer) };
    }
    resolved.set(entry, object);
    return object;
  };
  const added: string[] = [];
  for (const entry of entries) {
    const object = resolve(entry, 0);
    added.push(storeObject(store, object.type, object.data));
  }
  return added;
}

/** Ancestor walk: every commit reachable from `tips` (inclusive), parents followed. */
export function reachableCommits(store: Map<string, GitObject>, tips: string[], stopAt?: Set<string>): Set<string> {
  const seen = new Set<string>();
  const stack = [...tips];
  while (stack.length > 0) {
    const oid = stack.pop() as string;
    if (seen.has(oid)) continue;
    if (stopAt && stopAt.has(oid)) continue;
    const object = store.get(oid);
    if (!object || object.type !== 'commit') continue;
    seen.add(oid);
    for (const parent of parseCommit(object.data).parents) stack.push(parent);
  }
  return seen;
}

/** True when `ancestor` is reachable from `descendant` (both commits). */
export function isAncestor(store: Map<string, GitObject>, ancestor: string, descendant: string): boolean {
  if (ancestor === descendant) return true;
  return reachableCommits(store, [descendant]).has(ancestor);
}

/** A best common ancestor of two commits (lowest total distance), or null. */
export function mergeBase(store: Map<string, GitObject>, a: string, b: string): string | null {
  const distances = (tip: string): Map<string, number> => {
    const dist = new Map<string, number>();
    let frontier = [tip];
    let depth = 0;
    while (frontier.length > 0) {
      const next: string[] = [];
      for (const oid of frontier) {
        if (dist.has(oid)) continue;
        const object = store.get(oid);
        if (!object || object.type !== 'commit') continue;
        dist.set(oid, depth);
        for (const parent of parseCommit(object.data).parents) next.push(parent);
      }
      frontier = next;
      depth += 1;
    }
    return dist;
  };
  const fromA = distances(a);
  const fromB = distances(b);
  let best: string | null = null;
  let bestScore = Infinity;
  for (const [oid, da] of fromA) {
    const db = fromB.get(oid);
    if (db === undefined) continue;
    const score = da + db;
    if (score < bestScore) {
      bestScore = score;
      best = oid;
    }
  }
  return best;
}
