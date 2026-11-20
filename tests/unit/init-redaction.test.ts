import { describe, expect, it } from "vitest";
import { redactInitText, redactInitIo } from "../../src/init/redaction.js";
import type { InitIo } from "../../src/init/prompt.js";

const ATTESTATION =
  "This TinyFish API key belongs to an account with no wallet spending capability; free credits, a zero balance, disabled auto-reload, and installation success are not substitutes for this attestation.";

describe("public phrase exemption", () => {
  it("keeps a declared phrase verbatim when a credential is a substring of it", () => {
    const rendered = redactInitText(`Confirm: ${ATTESTATION}`, { TINYFISH_API_KEY: "wallet" }, [ATTESTATION]);
    expect(rendered).toContain(ATTESTATION);
    expect(rendered).not.toContain("[redacted]");
  });

  it("does not split a credential that straddles the phrase edge", () => {
    const secret = `PRE-${ATTESTATION}-POST`;
    const rendered = redactInitText(`Confirm: ${secret}`, { TINYFISH_API_KEY: secret }, [ATTESTATION]);
    expect(rendered).not.toContain(secret);
    expect(rendered).not.toContain(ATTESTATION);
    expect(rendered).toContain("[redacted]");
  });

  it("never exempts a phrase that is itself the credential value", () => {
    const rendered = redactInitText(`value ${ATTESTATION}`, { TINYFISH_API_KEY: ATTESTATION }, [ATTESTATION]);
    expect(rendered).not.toContain("wallet spending");
    expect(rendered).toContain("[redacted]");
  });

  it("ignores empty phrases", () => {
    const rendered = redactInitText("secret hunter2", { TINYFISH_API_KEY: "hunter2" }, [""]);
    expect(rendered).toBe("secret [redacted]");
  });

  it("still redacts a credential outside an exempt phrase", () => {
    const rendered = redactInitText(`hunter2 then ${ATTESTATION}`, { TINYFISH_API_KEY: "hunter2" }, [ATTESTATION]);
    expect(rendered).not.toContain("hunter2");
    expect(rendered).toContain(ATTESTATION);
  });

  it("redacts through the io wrapper on every channel", () => {
    const lines: string[] = [];
    const io: InitIo = {
      prompt: {
        interactive: true,
        confirm: async (question) => {
          lines.push(`confirm:${question}`);
          return false;
        },
        close: () => {},
      },
      writeLine: (line) => lines.push(`out:${line}`),
      errorLine: (line) => lines.push(`err:${line}`),
    };
    const wrapped = redactInitIo(io, { TINYFISH_API_KEY: "hunter2" }, [ATTESTATION]);
    wrapped.writeLine(`leak hunter2 ${ATTESTATION}`);
    wrapped.errorLine("leak hunter2");
    void wrapped.prompt.confirm("attest hunter2");
    expect(lines[0]).toBe(`out:leak [redacted] ${ATTESTATION}`);
    expect(lines[1]).toBe("err:leak [redacted]");
    expect(lines[2]).toBe("confirm:attest [redacted]");
  });
});
