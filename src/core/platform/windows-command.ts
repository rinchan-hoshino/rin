export function windowsCmdQuote(value: string) {
  return `"${String(value).replace(/"/g, '""')}"`;
}
