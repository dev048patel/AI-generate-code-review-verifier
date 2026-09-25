export function getUserName(user: { name: string } | null): string {
  if (user === null) return "guest";
  return user.name;
}
