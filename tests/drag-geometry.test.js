import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  computeInsertIndex,
  findNearestRect,
  isPointInsideRect,
  shouldInsertAfter,
  toPlainRect,
} from "../src/js/drag-geometry.js";

/** 100x100 的方块，左上角在 (left, top) */
function rect(left, top, size = 100) {
  return { left, top, right: left + size, bottom: top + size, width: size, height: size };
}

describe("drag-geometry findNearestRect", () => {
  it("returns the rect whose area contains the point", () => {
    const rects = [rect(0, 0), rect(200, 0), rect(400, 0)];
    assert.equal(findNearestRect(rects, 250, 50).index, 1);
  });

  it("picks the closest rect when the point is in a gap", () => {
    const rects = [rect(0, 0), rect(200, 0)];
    // x=120 距左边块右边 20，距右边块左边 80
    assert.equal(findNearestRect(rects, 120, 50).index, 0);
    assert.equal(findNearestRect(rects, 190, 50).index, 1);
  });

  it("handles empty input without throwing", () => {
    const res = findNearestRect([], 10, 10);
    assert.equal(res.index, 0);
    assert.equal(res.distance, Number.POSITIVE_INFINITY);
  });

  it("handles null/undefined input", () => {
    assert.doesNotThrow(() => findNearestRect(null, 0, 0));
    assert.doesNotThrow(() => findNearestRect(undefined, 0, 0));
  });
});

describe("drag-geometry shouldInsertAfter", () => {
  const r = rect(100, 100); // left=100 right=200 top=100 bottom=200, center=(150,150)

  it("inserts before when dropped to the left", () => {
    assert.equal(shouldInsertAfter(r, 50, 150), false);
  });

  it("inserts after when dropped to the right", () => {
    assert.equal(shouldInsertAfter(r, 250, 150), true);
  });

  it("inserts before when dropped above", () => {
    assert.equal(shouldInsertAfter(r, 150, 50), false);
  });

  it("inserts after when dropped below", () => {
    assert.equal(shouldInsertAfter(r, 150, 250), true);
  });

  it("uses horizontal half near the row center line", () => {
    // y=150 正好在中心，靠近中线 → 按左右判断
    assert.equal(shouldInsertAfter(r, 120, 150), false, "左半区 → 前");
    assert.equal(shouldInsertAfter(r, 180, 150), true, "右半区 → 后");
  });

  it("uses vertical half away from the row center line", () => {
    // y=110 距中心 40，超过 100*0.35=35 → 按上下判断
    assert.equal(shouldInsertAfter(r, 180, 110), false, "偏上 → 前，即使偏右");
    assert.equal(shouldInsertAfter(r, 120, 190), true, "偏下 → 后，即使偏左");
  });

  it("tolerates a null rect", () => {
    assert.equal(shouldInsertAfter(null, 0, 0), false);
  });
});

describe("drag-geometry computeInsertIndex", () => {
  const list = ["a", "b", "c"];

  it("clamps to list length for an unknown target", () => {
    assert.equal(computeInsertIndex(list, "zzz", null, 0, 0), 3);
  });

  it("returns target index when the tile element is missing", () => {
    assert.equal(computeInsertIndex(list, "b", null, 0, 0), 1);
  });

  it("computes before/after within bounds", () => {
    const r = rect(100, 100);
    assert.equal(computeInsertIndex(list, "b", r, 120, 150), 1, "插到 b 之前");
    assert.equal(computeInsertIndex(list, "b", r, 180, 150), 2, "插到 b 之后");
  });

  it("does not exceed list length when inserting after the last item", () => {
    const r = rect(100, 100);
    assert.equal(computeInsertIndex(list, "c", r, 180, 150), 3);
  });

  it("handles non-array input", () => {
    assert.equal(computeInsertIndex(null, "a", rect(0, 0), 10, 10), 0);
  });
});

describe("drag-geometry isPointInsideRect", () => {
  const r = rect(100, 100);

  it("detects inside", () => {
    assert.equal(isPointInsideRect(r, 150, 150), true);
  });

  it("detects outside on each side", () => {
    assert.equal(isPointInsideRect(r, 99, 150), false);
    assert.equal(isPointInsideRect(r, 201, 150), false);
    assert.equal(isPointInsideRect(r, 150, 99), false);
    assert.equal(isPointInsideRect(r, 150, 201), false);
  });

  it("treats borders as inside", () => {
    assert.equal(isPointInsideRect(r, 100, 100), true);
    assert.equal(isPointInsideRect(r, 200, 200), true);
  });

  it("tolerates null", () => {
    assert.equal(isPointInsideRect(null, 0, 0), false);
  });
});

describe("drag-geometry toPlainRect", () => {
  it("copies all geometry fields", () => {
    const domRect = { left: 1, top: 2, right: 11, bottom: 12, width: 10, height: 10 };
    assert.deepEqual(toPlainRect(domRect), domRect);
  });
});
