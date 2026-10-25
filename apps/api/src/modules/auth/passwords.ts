import bcrypt from "bcryptjs";

/** bcrypt, cost 10. The only place passwords are hashed or compared. */
export const hashPassword = (pw: string) => bcrypt.hash(pw, 10);
export const verifyPassword = (pw: string, hash: string) => bcrypt.compare(pw, hash);
