// Abuse identity only: keep the original address for delivery and existing wallet keys.
export function normalizeStarterEmail(email: string): string {
  const [local, domain] = email.trim().normalize("NFC").toLowerCase().split("@");
  const name = local.split("+")[0];
  return (domain === "gmail.com" || domain === "googlemail.com" ? name.replaceAll(".", "") + "@gmail.com" : name + "@" + domain);
}
export function starterCap(value: string | undefined, fallback: number): number {
  const n = value === undefined ? fallback : Number(value);
  if (!Number.isSafeInteger(n) || n < 0) throw new Error("starter caps must be non-negative safe integers");
  return n;
}
