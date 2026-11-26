import { nodes, workspaceMembers, type Db } from "@sync/db";
import { JWT_AUDIENCE, JWT_ISSUER, type Role } from "@sync/shared";
import { and, eq } from "drizzle-orm";
import { createRemoteJWKSet, jwtVerify, type JWTVerifyGetKey } from "jose";
import { z } from "zod";

export type CollabContext = { userId: string; workspaceId: string; role: Role };

export function remoteKeys(jwksUrl: string): JWTVerifyGetKey {
  return createRemoteJWKSet(new URL(jwksUrl));
}

const nodeId = z.uuid();

/** Hocuspocus sends `reason` (not `message`) to the client in its permission-denied reply. */
export class Denied extends Error {
  reason = this.message;
}

/** Verifies the RS256 token and the user's membership in the document's workspace. Throws on denial. */
export async function authorize(db: Db, keys: JWTVerifyGetKey, token: string, documentName: string): Promise<CollabContext> {
  const { payload } = await jwtVerify(token, keys, { algorithms: ["RS256"], audience: JWT_AUDIENCE, issuer: JWT_ISSUER });
  if (!payload.sub) throw new Error("token has no subject");
  if (!nodeId.safeParse(documentName).success) throw new Error("document name must be a node id");

  const [row] = await db
    .select({ workspaceId: nodes.workspaceId, role: workspaceMembers.role })
    .from(nodes)
    .leftJoin(workspaceMembers, and(eq(workspaceMembers.workspaceId, nodes.workspaceId), eq(workspaceMembers.userId, payload.sub)))
    .where(eq(nodes.id, documentName));
  // Transient for pages created offline that PowerSync has not uploaded yet; clients wait and retry.
  if (!row) throw new Denied(`not found: ${documentName}`);
  if (!row.role) throw new Denied(`forbidden: not a member of workspace ${row.workspaceId}`);
  return { userId: payload.sub, workspaceId: row.workspaceId, role: row.role };
}
