import type { Command } from "commander";
import { describe, expect, it } from "vitest";
import type { CliContext } from "../../src/cli/main.js";
import { buildProbe, buildProgram } from "../../src/cli/main.js";

/** Context that swallows output: the drift test only inspects declared shape. */
const silentContext: CliContext = {
  out: () => {},
  err: () => {},
  exit: () => {},
};

/** The parts of a declared command the probe must mirror exactly. */
interface CommandShape {
  optionFlags: string[];
  mandatoryOptions: string[];
  allowExcessArguments: boolean | undefined;
  arguments: { name: string; required: boolean; variadic: boolean }[];
}

function shapeOf(command: Command): CommandShape {
  return {
    optionFlags: command.options.map((option) => option.flags),
    mandatoryOptions: command.options.filter((option) => option.mandatory).map((option) => option.flags),
    allowExcessArguments: excessArgumentPolicy(command),
    arguments: command.registeredArguments.map((argument) => ({
      name: argument.name(),
      required: argument.required,
      variadic: argument.variadic,
    })),
  };
}

/**
 * Commander keeps this policy on a private field with no public reader; the
 * drift test compares it so a looser probe cannot let help/version mask an
 * excess-argument error the real program would reject.
 */
function excessArgumentPolicy(command: Command): boolean | undefined {
  return (command as unknown as { _allowExcessArguments?: boolean })._allowExcessArguments;
}

/**
 * The real program and the validation probe are built through one shared
 * declareCommands seam, so a command cannot exist in one tree and not the
 * other. These tests hold that invariant: reintroducing a separate command
 * list in either builder, or declaring an option or argument on only one
 * tree, fails here — the drift that once reopened help/version masking for
 * whole commands (issue #17 review round 3, finding 2) cannot return silent.
 */
describe("validation probe stays in lockstep with the real program", () => {
  const program = buildProgram("0.0.0-drift", silentContext, { code: 0 });
  const probe = buildProbe(silentContext);

  it("declares the same command names in the same order", () => {
    expect(probe.commands.map((command) => command.name())).toEqual(program.commands.map((command) => command.name()));
  });

  it("declares the same option flags and argument shapes for every command", () => {
    const programShapes = new Map(program.commands.map((command) => [command.name(), shapeOf(command)] as const));
    expect(programShapes.size).toBe(program.commands.length);
    for (const command of probe.commands) {
      expect(shapeOf(command), `declared shape of the '${command.name()}' command`).toEqual(programShapes.get(command.name()));
    }
  });

  it("differs at the program level only by the help and version short-circuit flags", () => {
    // The probe intentionally drops the program-level help and version
    // options so parsing it can only validate argv. The help flag is held
    // lazily outside `.options` until parse, configured once in the shared
    // baseProgram, so it cannot differ between the trees; every other
    // program-level option must be declared on both, with the same mandatory
    // and excess-argument policy.
    const shortCircuitFlags = ["-h, --help", "-v, --version"];
    expect(probe.options.map((option) => option.flags)).toEqual(
      program.options.map((option) => option.flags).filter((flags) => !shortCircuitFlags.includes(flags)),
    );
    expect(excessArgumentPolicy(probe)).toBe(excessArgumentPolicy(program));
  });
});
