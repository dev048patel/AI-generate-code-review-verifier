function isValid(value: string): boolean {
  return value.length > 0;
}

export function isInvalid(value: string): boolean {
  return isValid(value);
}
