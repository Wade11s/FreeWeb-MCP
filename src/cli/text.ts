/** Appends the line terminator the CLI uses for every outgoing line. */
export function text(value: string): string {
  return `${value}\n`;
}
