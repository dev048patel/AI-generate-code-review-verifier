const db = {
  query: (sql: string): Promise<unknown[]> => Promise.resolve([]),
};

export function findUserByName(name: string): Promise<unknown[]> {
  return db.query("SELECT * FROM users WHERE name = '" + name + "'");
}
