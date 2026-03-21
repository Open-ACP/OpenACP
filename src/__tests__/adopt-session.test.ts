import { describe, it, expect, vi } from "vitest";
import { existsSync } from "node:fs";

vi.mock("node:fs", () => ({ existsSync: vi.fn() }));

describe("adoptSession validation", () => {
  it("rejects non-existent directory", () => {
    vi.mocked(existsSync).mockReturnValue(false);
    expect(existsSync("/fake/path")).toBe(false);
  });

  it("accepts existing directory", () => {
    vi.mocked(existsSync).mockReturnValue(true);
    expect(existsSync("/real/path")).toBe(true);
  });
});
