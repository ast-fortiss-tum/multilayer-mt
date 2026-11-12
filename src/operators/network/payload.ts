/**
 * Pure JSON payload transformations used by the network payload/ordering
 * operators (thesis Sec. 4.2.1, "Network Layer Operators").
 *
 * Every function returns `{ changed, value }`; `changed === false` means the
 * operator is not applicable to this payload (pre-check failure).
 */
export interface Transformed {
  changed: boolean;
  value: unknown;
  detail?: string;
}

type Json = unknown;

function isObj(v: Json): v is Record<string, Json> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** Apply `fn` to every object (depth-first) that owns `field`. */
function mapObjectsWithField(v: Json, field: string, fn: (o: Record<string, Json>) => Record<string, Json>): Transformed {
  let count = 0;
  const walk = (x: Json): Json => {
    if (Array.isArray(x)) return x.map(walk);
    if (isObj(x)) {
      const out: Record<string, Json> = {};
      for (const [k, val] of Object.entries(x)) out[k] = walk(val);
      if (Object.prototype.hasOwnProperty.call(out, field)) {
        count++;
        return fn(out);
      }
      return out;
    }
    return x;
  };
  const value = walk(v);
  return { changed: count > 0, value, detail: count ? `${count} object(s) affected` : undefined };
}

export function dropField(v: Json, fieldName: string): Transformed {
  return mapObjectsWithField(v, fieldName, (o) => {
    const { [fieldName]: _drop, ...rest } = o;
    return rest;
  });
}

export function renameField(v: Json, oldName: string, newName: string): Transformed {
  return mapObjectsWithField(v, oldName, (o) => {
    const out: Record<string, Json> = {};
    for (const [k, val] of Object.entries(o)) out[k === oldName ? newName : k] = val;
    return out;
  });
}

/** string <-> number conversion when possible. */
export function changeType(v: Json, fieldName: string, toType: 'string' | 'number' | 'auto' = 'auto'): Transformed {
  let converted = 0;
  const res = mapObjectsWithField(v, fieldName, (o) => {
    const cur = o[fieldName];
    let next: Json = cur;
    if ((toType === 'string' || toType === 'auto') && typeof cur === 'number') next = String(cur);
    else if ((toType === 'number' || toType === 'auto') && typeof cur === 'string' && cur.trim() !== '' && !isNaN(Number(cur)))
      next = Number(cur);
    else if (toType === 'auto' && typeof cur === 'boolean') next = String(cur);
    if (next !== cur) converted++;
    return { ...o, [fieldName]: next };
  });
  return { changed: converted > 0, value: res.value, detail: `${converted} value(s) converted` };
}

export function invalidEnum(v: Json, fieldName: string, invalidValue: Json): Transformed {
  let n = 0;
  const res = mapObjectsWithField(v, fieldName, (o) => {
    if (o[fieldName] === invalidValue) return o;
    n++;
    return { ...o, [fieldName]: invalidValue };
  });
  return { changed: n > 0, value: res.value };
}

/** Insert an unexpected field into the top-level object (or every element of a top-level array). */
export function addField(v: Json, fieldName: string, fieldValue: Json): Transformed {
  if (isObj(v)) {
    if (Object.prototype.hasOwnProperty.call(v, fieldName)) return { changed: false, value: v };
    return { changed: true, value: { ...v, [fieldName]: fieldValue } };
  }
  if (Array.isArray(v) && v.some(isObj)) {
    return { changed: true, value: v.map((e) => (isObj(e) && !(fieldName in e) ? { ...e, [fieldName]: fieldValue } : e)) };
  }
  return { changed: false, value: v };
}

/** Reorder the first array (breadth-first) with at least two distinct elements. */
export function reorderArrays(v: Json, strategy: 'reverse' | 'shuffle' = 'reverse', rand: () => number = Math.random): Transformed {
  const reorder = (arr: Json[]): Json[] => {
    if (strategy === 'reverse') return [...arr].reverse();
    const out = [...arr];
    for (let i = out.length - 1; i > 0; i--) {
      const j = Math.floor(rand() * (i + 1));
      [out[i], out[j]] = [out[j], out[i]];
    }
    if (JSON.stringify(out) === JSON.stringify(arr)) out.push(out.shift() as Json);
    return out;
  };
  const differs = (a: Json[]) => a.length >= 2 && new Set(a.map((x) => JSON.stringify(x))).size > 1;

  if (Array.isArray(v) && differs(v)) return { changed: true, value: reorder(v), detail: 'top-level array reordered' };
  // breadth-first search for the first nested array
  const queue: { parent: Record<string, Json> | Json[]; key: string | number; val: Json }[] = [];
  const root = structuredCloneSafe(v);
  const enqueue = (p: Record<string, Json> | Json[]) => {
    if (Array.isArray(p)) p.forEach((val, i) => queue.push({ parent: p, key: i, val }));
    else Object.entries(p).forEach(([k, val]) => queue.push({ parent: p, key: k, val }));
  };
  if (isObj(root) || Array.isArray(root)) enqueue(root as any);
  while (queue.length) {
    const { parent, key, val } = queue.shift()!;
    if (Array.isArray(val) && differs(val)) {
      (parent as any)[key] = reorder(val);
      return { changed: true, value: root, detail: `array at "${String(key)}" reordered` };
    }
    if (isObj(val) || Array.isArray(val)) enqueue(val as any);
  }
  return { changed: false, value: v };
}

function structuredCloneSafe<T>(v: T): T {
  return v === undefined ? v : JSON.parse(JSON.stringify(v));
}
