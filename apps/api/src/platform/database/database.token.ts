/** The Drizzle client's injection token, in a file of its own so `Database` and the module can both import it without a cycle. */
export const DATABASE = Symbol("DATABASE");
