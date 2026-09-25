const db = {
  deleteSession: (id: string): Promise<void> => Promise.resolve(),
};
let endedSessions: string[] = [];

export async function endSession(sessionId: string): Promise<void> {
  await db.deleteSession(sessionId);
  endedSessions.push(sessionId);
}
