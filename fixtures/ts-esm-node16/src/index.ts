// WHY: Entry point that pulls in both ./schemas.js and ./api.js using the
// NodeNext convention. Both specifiers point to .ts files on disk; the .js
// extension is mandatory in NodeNext source code.
import { fetchUser, createSession } from "./api.js";
import { isExpired } from "./schemas.js";
import type { User, Session } from "./schemas.js";

export async function login(userId: string): Promise<{ user: User; session: Session }> {
  const session = await createSession(userId);
  if (isExpired(session)) {
    throw new Error("Session already expired");
  }
  const user = await fetchUser(userId);
  return { user, session };
}
