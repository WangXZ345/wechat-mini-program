import { describe, expect, it } from "vitest";
import { formatMoney } from "./format";

describe("formatMoney", () => {
  it("preserves a real zero amount", () => {
    expect(formatMoney(0)).toBe("¥0.00");
  });

  it.each([undefined, null, "", "0", Number.NaN, 1.5, Number.MAX_SAFE_INTEGER + 1])(
    "shows a dash for a missing or invalid amount: %s",
    (value) => {
      expect(formatMoney(value)).toBe("-");
    }
  );
});
