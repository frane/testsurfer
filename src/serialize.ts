/**
 * Values crossing the page boundary. JSON alone loses undefined, NaN,
 * Infinity, -0, Date, RegExp, BigInt, Error, Map and Set, and chokes on
 * cycles; Playwright's evaluate keeps them. Both sides use the same
 * tagged form: plain JSON for plain values, `{ $t: tag, v }` otherwise.
 */

/** Page-side `ser(value)` and `des(tagged)`, as an expression yielding `{ ser, des }`. */
export const SERIALIZE_JS = `(function(){
function ser(v,seen){seen=seen||[];
if(v===undefined)return {$t:'u'};
if(typeof v==='number'){if(Number.isNaN(v))return {$t:'n',v:'NaN'};if(v===Infinity)return {$t:'n',v:'Infinity'};if(v===-Infinity)return {$t:'n',v:'-Infinity'};if(Object.is(v,-0))return {$t:'n',v:'-0'};return v;}
if(typeof v==='bigint')return {$t:'b',v:String(v)};
if(v===null||typeof v==='string'||typeof v==='boolean')return v;
if(typeof v==='function'||typeof v==='symbol')return {$t:'u'};
if(typeof Date==='function'&&v instanceof Date)return {$t:'d',v:v.toISOString()};
if(typeof RegExp==='function'&&v instanceof RegExp)return {$t:'r',v:[v.source,v.flags]};
if(typeof URL==='function'&&v instanceof URL)return {$t:'url',v:v.href};
if(typeof Error==='function'&&v instanceof Error)return {$t:'e',v:{name:v.name,message:v.message,stack:v.stack}};
if(typeof Node==='function'&&v instanceof Node)return {$t:'node',v:v.nodeName};
if(typeof Window==='function'&&v instanceof Window)return {$t:'win'};
if(seen.indexOf(v)>=0)return {$t:'cyc'};
seen.push(v);
try{
if(Array.isArray(v)||(typeof v.length==='number'&&typeof v!=='string'&&((typeof NodeList==='function'&&v instanceof NodeList)||(typeof HTMLCollection==='function'&&v instanceof HTMLCollection))))return Array.prototype.map.call(v,function(x){return ser(x,seen);});
if(typeof Map==='function'&&v instanceof Map)return {$t:'map',v:Array.from(v.entries()).map(function(e){return [ser(e[0],seen),ser(e[1],seen)];})};
if(typeof Set==='function'&&v instanceof Set)return {$t:'set',v:Array.from(v).map(function(x){return ser(x,seen);})};
if(ArrayBuffer.isView(v))return Array.from(v);
var o={};for(var k in v){try{o[k]=ser(v[k],seen);}catch(e){}}
return {$t:'o',v:o};
}finally{seen.pop();}}
var H={get:function(){return undefined;}};
function des(v){
if(v===null||typeof v!=='object')return v;
if(Array.isArray(v))return v.map(des);
switch(v.$t){
case 'u':return undefined;
case 'n':return v.v==='-0'?-0:Number(v.v);
case 'b':return BigInt(v.v);
case 'd':return new Date(v.v);
case 'r':return new RegExp(v.v[0],v.v[1]);
case 'url':return new URL(v.v);
case 'e':var e=new Error(v.v.message);e.name=v.v.name;return e;
case 'map':return new Map(v.v.map(function(p){return [des(p[0]),des(p[1])];}));
case 'set':return new Set(v.v.map(des));
case 'h':return H.get(v.v);
case 'o':var o={};for(var k in v.v)o[k]=des(v.v[k]);return o;
}
return v;}
return {ser:ser,des:des,H:H};})()`;

type Tagged = null | boolean | number | string | Tagged[] | { $t: string; v?: unknown };

/** Node-side encode, mirror of the page-side `ser`. */
export function serializeValue(v: unknown, seen: unknown[] = []): Tagged {
  if (v === undefined) return { $t: 'u' };
  // A JSHandle or ElementHandle passes as a reference to the page-side value.
  if (typeof v === 'object' && v !== null && typeof (v as { handleId?: unknown }).handleId === 'number') {
    return { $t: 'h', v: (v as { handleId: number }).handleId };
  }
  if (typeof v === 'number') {
    if (Number.isNaN(v)) return { $t: 'n', v: 'NaN' };
    if (v === Infinity) return { $t: 'n', v: 'Infinity' };
    if (v === -Infinity) return { $t: 'n', v: '-Infinity' };
    if (Object.is(v, -0)) return { $t: 'n', v: '-0' };
    return v;
  }
  if (typeof v === 'bigint') return { $t: 'b', v: String(v) };
  if (v === null || typeof v === 'string' || typeof v === 'boolean') return v;
  if (typeof v === 'function' || typeof v === 'symbol') return { $t: 'u' };
  if (v instanceof Date) return { $t: 'd', v: v.toISOString() };
  if (v instanceof RegExp) return { $t: 'r', v: [v.source, v.flags] };
  if (v instanceof URL) return { $t: 'url', v: v.href };
  if (v instanceof Error) return { $t: 'e', v: { name: v.name, message: v.message, stack: v.stack } };
  if (seen.includes(v)) throw new Error('argument is not serializable: it has a cycle');
  seen.push(v);
  try {
    if (Array.isArray(v)) return v.map((x) => serializeValue(x, seen));
    if (v instanceof Map) return { $t: 'map', v: [...v.entries()].map(([a, b]) => [serializeValue(a, seen), serializeValue(b, seen)]) };
    if (v instanceof Set) return { $t: 'set', v: [...v].map((x) => serializeValue(x, seen)) };
    const o: Record<string, Tagged> = {};
    for (const [k, x] of Object.entries(v as object)) o[k] = serializeValue(x, seen);
    return { $t: 'o', v: o };
  } finally {
    seen.pop();
  }
}

/** Node-side decode of a page-side `ser` result. */
export function deserializeValue(v: unknown): unknown {
  if (v === null || typeof v !== 'object') return v;
  if (Array.isArray(v)) return v.map(deserializeValue);
  const t = v as { $t?: string; v?: unknown };
  switch (t.$t) {
    case 'u':
      return undefined;
    case 'n':
      return t.v === '-0' ? -0 : Number(t.v);
    case 'b':
      return BigInt(t.v as string);
    case 'd':
      return new Date(t.v as string);
    case 'r': {
      const [src, flags] = t.v as [string, string];
      return new RegExp(src, flags);
    }
    case 'url':
      return new URL(t.v as string);
    case 'e': {
      const d = t.v as { name: string; message: string; stack?: string };
      const e = new Error(d.message);
      e.name = d.name;
      return e;
    }
    case 'node':
    case 'win':
    case 'cyc':
      // A DOM node or window comes back as an empty object, as in
      // Playwright's evaluate (it is not serializable).
      return {};
    case 'map':
      return new Map((t.v as [unknown, unknown][]).map(([a, b]) => [deserializeValue(a), deserializeValue(b)]));
    case 'set':
      return new Set((t.v as unknown[]).map(deserializeValue));
    case 'o': {
      const o: Record<string, unknown> = {};
      for (const [k, x] of Object.entries(t.v as object)) o[k] = deserializeValue(x);
      return o;
    }
  }
  return v;
}
