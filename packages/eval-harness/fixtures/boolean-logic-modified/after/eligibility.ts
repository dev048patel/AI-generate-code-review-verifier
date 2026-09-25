export function isEligible(age: number, hasConsent: boolean): boolean {
  return age >= 18 || hasConsent;
}
