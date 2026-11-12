import { describe, expect, it } from "vitest";
import { downsample, splitSentences } from "./voice";

describe("splitSentences", () => {
  it("emits complete sentences and keeps the unfinished tail", () => {
    const r = splitSentences("Good evening. All systems are online and stable. The reactor is at");
    expect(r.sentences).toEqual(["Good evening. All systems are online and stable."]);
    expect(r.rest).toBe("The reactor is at");
  });

  it("merges very short sentences so each clip is worth synthesising", () => {
    const r = splitSentences("Done. Yes. The report is saved to your workspace now. ");
    expect(r.sentences).toEqual(["Done. Yes. The report is saved to your workspace now."]);
  });

  it("flushes the remainder at the end of a reply", () => {
    expect(splitSentences("Short tail", true)).toEqual({ sentences: ["Short tail"], rest: "" });
  });

  it("treats paragraph breaks as boundaries", () => {
    const r = splitSentences("First paragraph without punctuation\n\nSecond");
    expect(r.sentences).toEqual(["First paragraph without punctuation"]);
    expect(r.rest).toBe("Second");
  });

  it("is incremental: feeding deltas yields the same sentences", () => {
    const text = "The build passed on all platforms. Two pull requests await review. Nothing else is pending.";
    let buf = "";
    const out: string[] = [];
    for (const ch of text.match(/.{1,7}/g) ?? []) {
      buf += ch;
      const r = splitSentences(buf);
      out.push(...r.sentences);
      buf = r.rest;
    }
    out.push(...splitSentences(buf, true).sentences);
    expect(out.join(" ")).toBe(text);
  });
});

describe("downsample", () => {
  it("averages to the target rate", () => {
    const input = new Float32Array([1, 1, 0, 0, 1, 1]);
    expect(Array.from(downsample(input, 32000, 16000))).toEqual([1, 0, 1]);
  });
});
