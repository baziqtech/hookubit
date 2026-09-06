type ClassValue = string | number | null | undefined | false | ClassValue[];

/**
 * Minimal class joiner. Deliberately not `clsx` + `tailwind-merge`: the
 * component set below composes variants by construction rather than by
 * overriding them, so conflict resolution is not needed and two dependencies
 * are not worth the bundle.
 */
export function cn(...values: ClassValue[]): string {
  const out: string[] = [];
  for (const value of values) {
    if (!value) continue;
    if (Array.isArray(value)) {
      const nested = cn(...value);
      if (nested) out.push(nested);
    } else {
      out.push(String(value));
    }
  }
  return out.join(' ');
}
