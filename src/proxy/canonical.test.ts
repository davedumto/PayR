import { describe, expect, it } from "vitest";

import { CANONICAL_MAX_DEPTH, canonicalHash, canonicalJson } from "@/proxy/canonical";

describe("canonicalJson", () => {
  it("sorts object keys, so key order does not change the output", () => {
    expect(canonicalJson({ b: 1, a: { d: 2, c: 3 } })).toBe(
      canonicalJson({ a: { c: 3, d: 2 }, b: 1 }),
    );
    expect(canonicalJson({ b: 1, a: { d: 2, c: 3 } })).toBe('{"a":{"c":3,"d":2},"b":1}');
  });

  it("keeps array order, which is part of the value", () => {
    expect(canonicalJson([1, 2])).not.toBe(canonicalJson([2, 1]));
  });

  it.each([
    [
      "nested arrays of objects",
      { list: [{ z: 1, a: 2 }, { m: [true, null] }] },
      '{"list":[{"a":2,"z":1},{"m":[true,null]}]}',
    ],
    ["strings with unicode and escapes", { s: 'é\n"' }, '{"s":"é\\n\\""}'],
    ["numbers", { n: 0.5, m: -3, k: 1e21 }, '{"k":1e+21,"m":-3,"n":0.5}'],
    ["null and booleans", { a: null, b: false, c: true }, '{"a":null,"b":false,"c":true}'],
    ["empty object and array", { o: {}, a: [] }, '{"a":[],"o":{}}'],
  ])("encodes %s", (_name, value, expected) => {
    expect(canonicalJson(value)).toBe(expected);
  });

  it("drops undefined object members, as JSON does", () => {
    expect(canonicalJson({ a: 1, b: undefined })).toBe('{"a":1}');
  });

  it("rejects a value nested deeper than the cap instead of recursing forever", () => {
    let value: unknown = 0;
    for (let i = 0; i <= CANONICAL_MAX_DEPTH + 1; i += 1) {
      value = [value];
    }
    expect(() => canonicalJson(value)).toThrow(RangeError);
  });

  it("rejects values that have no JSON form", () => {
    expect(() => canonicalJson(undefined)).toThrow(TypeError);
    expect(() => canonicalJson(() => 1)).toThrow(TypeError);
  });
});

describe("canonicalHash", () => {
  it("is equal for two encodings of the same value", () => {
    expect(canonicalHash({ x: 1, y: [2] })).toBe(canonicalHash({ y: [2], x: 1 }));
  });

  it("differs when any value differs", () => {
    expect(canonicalHash({ amount: "500000" })).not.toBe(canonicalHash({ amount: "500001" }));
  });
});
