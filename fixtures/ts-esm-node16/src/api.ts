// WHY: Canonical API client for the fixture. Demonstrates the NodeNext
// .js-extension convention in cross-file imports — `./schemas.js` resolves
// to schemas.ts at build time and (after this fix) at sextant scan time.
import type { User, Session } from "./schemas.js";

export async function fetchUser(id: string): Promise<User> {
  const response = await fetch(`/api/users/${id}`);
  return (await response.json()) as User;
}

export async function createSession(userId: string): Promise<Session> {
  const response = await fetch(`/api/sessions`, {
    method: "POST",
    body: JSON.stringify({ userId }),
  });
  return (await response.json()) as Session;
}
