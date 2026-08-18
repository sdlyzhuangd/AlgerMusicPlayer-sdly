const EXPIRY_DATE = new Date('2027-12-30T00:00:00');

export function isExpired(): boolean {
  return new Date() >= EXPIRY_DATE;
}

export { EXPIRY_DATE };
